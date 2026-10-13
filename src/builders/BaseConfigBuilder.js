import { ProxyParser } from '../parsers/index.js';
import { createStableProviderName, deepCopy, tryDecodeSubscriptionLines, decodeBase64 } from '../utils.js';
import { createTranslator } from '../i18n/index.js';
import { generateRules, getOutbounds, PREDEFINED_RULE_SETS } from '../config/index.js';
import { InvalidPayloadError } from '../services/errors.js';
import { parseAutoSelectInterval } from '../config/autoSelectInterval.js';
import { buildNodeSelectMembers, buildOrdinaryMembers, buildSelectorMembers } from './helpers/groupBuilder.js';

export class BaseConfigBuilder {
    constructor(inputString, baseConfig, lang, userAgent, groupByCountry = false, includeAutoSelect = true, chainConfig = null, autoSelectInterval) {
        this.inputString = inputString;
        this.config = deepCopy(baseConfig);
        this.customRules = [];
        this.selectedRules = [];
        this.t = createTranslator(lang);
        this.userAgent = userAgent;
        this.groupByCountry = groupByCountry;
        this.includeAutoSelect = includeAutoSelect;
        this.autoSelectInterval = parseAutoSelectInterval(autoSelectInterval);
        this.providerUrls = [];  // URLs to use as providers (auto-sync)
        this.providerNodeNames = [];  // node names from provider subscriptions, for country enumeration only
        this.autoProviderDescriptors = undefined;
        this.subscriptionUserinfo = undefined;
        this.chainConfig = chainConfig;
        this.chainSourcesByLine = new Map((chainConfig?.sources || []).map(source => [source.line, source]));
        this.proxySourceIds = new WeakMap();
        this.sourceItems = new Map();
        this.sourceProxyNames = new Map();
        this.proxyAddedNames = new WeakMap();
        this.importSources = new Map();
        this.proxyImportSources = new WeakMap();
        this.sourceGroupNames = [];
        this.chainLandingGroupNames = [];
        this.chainAutoGroupNames = [];
        this.reservedGroupNames = new Set();
    }

    async build(subscriptionFetcher) {
        this.subscriptionFetcher = subscriptionFetcher;
        this.publicGroupNames = new Set([
            'DIRECT', 'REJECT', this.t('outboundNames.Node Select'), this.t('outboundNames.Fall Back'),
            ...this.getOutboundsList().map(name => this.t(`outboundNames.${name}`)),
            ...(Array.isArray(this.customRules) ? this.customRules : []).flatMap(rule => [rule.name, this.t(`outboundNames.${rule.name}`)])
        ]);
        this.publicGroupNames.forEach(name => this.reservedGroupNames.add(name));
        const customItems = await this.parseCustomItems();
        this.addCustomItems(customItems);
        this.originalProxyNames = new Set(this.getProxyList());
        this.ordinaryGroupName = this.reserveGroupName(this.t('ordinaryProxy'));
        this.allNodesGroupName = this.reserveGroupName(this.t('outboundNames.Manual Switch'));
        if (this.includeAutoSelect) {
            this.autoGroupName = this.reserveGroupName(this.t('outboundNames.Auto Select'));
        }
        this.addChains();
        this.addSelectors();
        return this.formatConfig();
    }

    async parseCustomItems() {
        const input = this.inputString || '';
        const parsedItems = [];

        // Import the content parser for direct input parsing
        const { parseSubscriptionContent } = await import('../parsers/subscription/subscriptionContentParser.js');

        // Try to parse the entire input as a config format (Sing-Box JSON or Clash YAML)
        const directResult = parseSubscriptionContent(input);
        if (directResult && typeof directResult === 'object' && directResult.type) {
            // It's a parsed config (singboxConfig or yamlConfig)
            if (Array.isArray(directResult.proxies)) {
                for (const proxy of directResult.proxies) {
                    if (proxy && proxy.tag) {
                        this.recordParsedItem(parsedItems, proxy, undefined, this.getImportSource(null, 'config'));
                    }
                }
                if (parsedItems.length > 0) return parsedItems;
            }
        }

        // If direct parsing didn't work, check for Base64 encoded content
        const isBase64Like = /^[A-Za-z0-9+/=\r\n]+$/.test(input) && input.replace(/[\r\n]/g, '').length % 4 === 0;
        if (isBase64Like) {
            try {
                const sanitized = input.replace(/\s+/g, '');
                const decodedWhole = decodeBase64(sanitized);
                if (typeof decodedWhole === 'string') {
                    const decodedResult = parseSubscriptionContent(decodedWhole);
                    if (decodedResult && typeof decodedResult === 'object' && decodedResult.type) {
                        if (Array.isArray(decodedResult.proxies)) {
                            for (const proxy of decodedResult.proxies) {
                                if (proxy && proxy.tag) {
                                    this.recordParsedItem(parsedItems, proxy, undefined, this.getImportSource(null, 'config'));
                                }
                            }
                            if (parsedItems.length > 0) return parsedItems;
                        }
                    }
                }
            } catch (_) { }
        }

        // Otherwise, line-by-line processing (URLs, subscription content, remote lists, etc.)
        const urls = input.split(/\r?\n/)
            .map((url, line) => ({ url, line }))
            .filter(item => item.url.trim() !== '');
        for (const { url, line } of urls) {
            const chainSource = this.chainSourcesByLine.get(line);
            const sourceId = chainSource?.id;
            let processedUrls = tryDecodeSubscriptionLines(url);
            if (!Array.isArray(processedUrls)) {
                processedUrls = [processedUrls];
            }

            for (const processedUrl of processedUrls) {
                const trimmedUrl = typeof processedUrl === 'string' ? processedUrl.trim() : '';
                const importSource = this.getImportSource(trimmedUrl);

                // Check if it's an HTTP(S) URL - may use as provider if format matches
                if (trimmedUrl.startsWith('http://') || trimmedUrl.startsWith('https://')) {
                    const { fetchSubscriptionWithFormat } = await import('../parsers/subscription/httpSubscriptionFetcher.js');

                    try {
                        const fetchResult = await fetchSubscriptionWithFormat(trimmedUrl, this.userAgent, this.subscriptionFetcher);
                        if (fetchResult) {
                            const { content, format, url: originalUrl, subscriptionUserinfo } = fetchResult;

                            if (subscriptionUserinfo && !this.subscriptionUserinfo) {
                                this.subscriptionUserinfo = subscriptionUserinfo;
                            }

                            // Chain membership must be resolved before OUT nodes can be excluded.
                            if (!this.chainConfig && this.isCompatibleProviderFormat(format)) {
                                this.providerUrls.push(originalUrl);
                                importSource.providerUrls.add(originalUrl);
                                // Content is already fetched; keep node names so country
                                // groups can be built over provider members later.
                                await this.collectProviderNodeNames(content);
                                continue;  // Skip parsing, will be used as provider
                            }

                            // Otherwise parse the content as usual
                            const result = parseSubscriptionContent(content);
                            await this.recordSubscriptionResult(parsedItems, result, sourceId, importSource, new Set([trimmedUrl]));
                        }
                    } catch (error) {
                        console.error('Error processing HTTP subscription:', error);
                    }
                    continue;
                }

                // Non-HTTP URLs (protocol URIs like ss://, vmess://, etc.)
                const result = await ProxyParser.parse(processedUrl, this.userAgent, this.subscriptionFetcher);
                await this.recordSubscriptionResult(parsedItems, result, sourceId, importSource);
            }
        }

        return parsedItems;
    }

    getImportSource(value, kind = 'manual') {
        const isRemote = typeof value === 'string' && /^https?:\/\//i.test(value);
        const id = isRemote ? value.trim() : kind;
        if (!this.importSources.has(id)) {
            let label = this.t(kind === 'config' ? 'configSource' : 'manualSource');
            if (isRemote) {
                try { label = new URL(value).hostname; } catch (_) { }
            }
            this.importSources.set(id, { label, nodeNames: new Set(), providerUrls: new Set() });
        }
        return this.importSources.get(id);
    }

    addSourceGroups() {
        this.getProviderNames?.();
        this.getProviderTags?.();
        const providers = this.autoProviderDescriptors || [];
        for (const source of this.importSources.values()) {
            const providerNames = providers.filter(provider => source.providerUrls.has(provider.url)).map(provider => provider.name);
            const members = [...source.nodeNames];
            if (members.length === 0 && providerNames.length === 0) continue;
            const name = this.reserveGroupName(`📥 ${source.label}`);
            this.addSelectorGroup(name, members, 'select', providerNames);
            this.sourceGroupNames.push(name);
        }
    }

    async recordSubscriptionResult(parsedItems, result, sourceId, importSource, seen = new Set()) {
        if (Array.isArray(result?.proxies)) {
            result.proxies.forEach(proxy => this.recordParsedItem(parsedItems, proxy, sourceId, importSource));
        } else if (Array.isArray(result)) {
            for (const item of result) {
                await this.recordSubscriptionResult(parsedItems, item, sourceId, importSource, seen);
            }
        } else if (typeof result === 'string') {
            const value = result.trim();
            if (!value || seen.has(value)) return;
            seen.add(value);
            const parsed = await ProxyParser.parse(value, this.userAgent, this.subscriptionFetcher);
            await this.recordSubscriptionResult(parsedItems, parsed, sourceId, importSource, seen);
        } else if (result?.tag) {
            this.recordParsedItem(parsedItems, result, sourceId, importSource);
        }
    }

    recordParsedItem(parsedItems, item, sourceId, importSource) {
        if (!item) return;
        if (Array.isArray(item)) {
            item.forEach(child => this.recordParsedItem(parsedItems, child, sourceId, importSource));
            return;
        }
        if (typeof item !== 'object' || !item.tag) return;
        // Imported detours may reference groups that are deliberately discarded.
        const { detour: _detour, ...node } = item;
        item = node;
        parsedItems.push(item);
        if (importSource && typeof item === 'object' && item.tag) {
            this.proxyImportSources.set(item, importSource);
        }
        if (!sourceId || typeof item !== 'object' || !item.tag) return;

        this.proxySourceIds.set(item, sourceId);
        if (!this.sourceItems.has(sourceId)) {
            this.sourceItems.set(sourceId, []);
        }
        this.sourceItems.get(sourceId).push(item);
    }

    /**
     * Check if subscription format is compatible for use as a provider
     * Override in child classes to enable provider support
     * @param {'clash'|'singbox'|'unknown'} format - Detected subscription format
     * @returns {boolean} - True if format can be used as provider
     */
    isCompatibleProviderFormat(format) {
        return false;  // Default: no provider support
    }

    /**
     * Extract node names from an already-fetched provider subscription.
     * Names are only used to enumerate countries for group filters; the nodes
     * themselves stay remote. Best-effort: provider mode must not fail here.
     */
    async collectProviderNodeNames(content) {
        try {
            const { parseSubscriptionContent } = await import('../parsers/subscription/subscriptionContentParser.js');
            const result = parseSubscriptionContent(content);
            const proxies = Array.isArray(result?.proxies) ? result.proxies : [];
            proxies.forEach(proxy => {
                const name = proxy?.tag ?? proxy?.name;
                if (typeof name === 'string' && name.trim()) {
                    this.providerNodeNames.push(name.trim());
                }
            });
        } catch (_) { }
    }

    getAutoProviderDescriptors(reservedNames = []) {
        if (this.autoProviderDescriptors) {
            return this.autoProviderDescriptors;
        }

        const usedNames = new Set(reservedNames);
        const providerNamesByUrl = new Map();
        const descriptors = [];

        for (const url of this.providerUrls) {
            if (typeof url !== 'string' || url.trim() === '') {
                throw new Error('Provider URL must be a non-empty string');
            }

            const normalizedUrl = url.trim();
            if (providerNamesByUrl.has(normalizedUrl)) {
                continue;
            }

            const baseName = createStableProviderName(normalizedUrl);
            let name = baseName;
            let suffix = 2;

            while (usedNames.has(name)) {
                name = `${baseName}_${suffix}`;
                suffix += 1;
            }

            usedNames.add(name);
            providerNamesByUrl.set(normalizedUrl, name);
            descriptors.push({ name, url: normalizedUrl });
        }

        this.autoProviderDescriptors = descriptors;
        return descriptors;
    }

    getSubscriptionUserinfo() {
        return this.subscriptionUserinfo;
    }

    getOutboundsList() {
        let outbounds;
        if (typeof this.selectedRules === 'string' && PREDEFINED_RULE_SETS[this.selectedRules]) {
            outbounds = getOutbounds(PREDEFINED_RULE_SETS[this.selectedRules]);
        } else if (this.selectedRules && Object.keys(this.selectedRules).length > 0) {
            outbounds = getOutbounds(this.selectedRules);
        } else {
            outbounds = getOutbounds(PREDEFINED_RULE_SETS.minimal);
        }
        return outbounds;
    }

    getProxyList() {
        return this.getProxies().map(proxy => this.getProxyName(proxy));
    }

    getProxies() {
        throw new Error('getProxies must be implemented in child class');
    }

    getProxyName(proxy) {
        throw new Error('getProxyName must be implemented in child class');
    }

    convertProxy(proxy) {
        throw new Error('convertProxy must be implemented in child class');
    }

    addProxyToConfig(proxy) {
        throw new Error('addProxyToConfig must be implemented in child class');
    }

    addAutoSelectGroup(proxyList) {
        const providers = this.getProviderReferences();
        if (this.includeAutoSelect && (proxyList.length > 0 || providers.length > 0)) {
            this.addSelectorGroup(this.autoGroupName, proxyList, 'url-test', providers);
        }
    }

    addNodeSelectGroup() {
        const name = this.t('outboundNames.Node Select');
        if (!this.hasConfigGroup(name)) {
            this.addSelectorGroup(name, this.getNodeSelectMembers(this.supportsReject !== false));
        }
    }

    addOutboundGroups(outbounds, proxyList) {
        throw new Error('addOutboundGroups must be implemented in child class');
    }

    addCustomRuleGroups(proxyList) {
        throw new Error('addCustomRuleGroups must be implemented in child class');
    }

    addFallBackGroup(proxyList) {
        throw new Error('addFallBackGroup must be implemented in child class');
    }

    addCountryGroups() {
        throw new Error('addCountryGroups must be implemented in child class');
    }

    addCustomItems(customItems) {
        const validItems = customItems.filter(item => item != null);
        validItems.forEach(item => {
            if (item?.tag) {
                // Fixed rule targets must remain groups even when an imported node shares their name.
                const tag = this.publicGroupNames.has(item.tag) ? this.reserveGroupName(item.tag) : item.tag;
                const convertedProxy = this.convertProxy({ ...item, tag });
                if (convertedProxy) {
                    const addedProxy = this.addProxyToConfig(convertedProxy);
                    if (addedProxy && this.isUsableChainProxy(addedProxy)) {
                        this.proxyAddedNames.set(item, this.getProxyName(addedProxy));
                    }
                    const importSource = this.proxyImportSources.get(item);
                    if (importSource && addedProxy && this.isUsableChainProxy(addedProxy)) {
                        importSource.nodeNames.add(this.getProxyName(addedProxy));
                    }
                    const sourceId = this.proxySourceIds.get(item);
                    if (sourceId && addedProxy && this.isUsableChainProxy(addedProxy)) {
                        if (!this.sourceProxyNames.has(sourceId)) {
                            this.sourceProxyNames.set(sourceId, []);
                        }
                        const name = this.getProxyName(addedProxy);
                        if (name && !this.sourceProxyNames.get(sourceId).includes(name)) {
                            this.sourceProxyNames.get(sourceId).push(name);
                        }
                    }
                }
            }
        });
    }

    isUsableChainProxy(proxy) {
        return !!proxy;
    }

    hasConfigGroup() {
        return false;
    }

    addSelectorGroup() {
        throw new Error('addSelectorGroup must be implemented in child class');
    }

    applyChainToProxy() {
        throw new Error('applyChainToProxy must be implemented in child class');
    }

    reserveGroupName(baseName) {
        const usedProxyNames = new Set(this.getProxyList());
        let name = baseName;
        let suffix = 2;
        while (usedProxyNames.has(name) || this.hasConfigGroup(name) || this.reservedGroupNames.has(name)) {
            name = `${baseName} ${suffix}`;
            suffix += 1;
        }
        this.reservedGroupNames.add(name);
        return name;
    }

    addChains() {
        const exit = this.chainConfig?.exit;
        if (!exit) return;

        const exitNames = new Set(this.sourceProxyNames.get(exit.id) || []);
        if (exitNames.size === 0) {
            throw new InvalidPayloadError(`Chain OUT source has no supported proxies: ${exit.label}`);
        }
        this.chainEntryProxyNames = this.getProxies()
            .filter(proxy => this.isUsableChainProxy(proxy) && !exitNames.has(this.getProxyName(proxy)))
            .map(proxy => this.getProxyName(proxy));
        if (this.chainEntryProxyNames.length === 0) {
            throw new InvalidPayloadError('Chain requires supported IN nodes outside the OUT source');
        }
        this.chainEntryGroupName = this.reserveGroupName(this.t('chainEntry'));
        this.addSelectorGroup(this.chainEntryGroupName, this.chainEntryProxyNames);

        const seenExits = new Set();
        (this.sourceItems.get(exit.id) || []).forEach(item => {
            const exitName = this.proxyAddedNames.get(item);
            if (!exitName || seenExits.has(exitName)) return;
            seenExits.add(exitName);
            const addPath = (entryName, label) => {
                const cloned = deepCopy(item);
                cloned.tag = this.reserveGroupName(`${label} · ${exitName}`);
                const converted = this.convertProxy(cloned);
                const chained = converted && this.applyChainToProxy(converted, entryName);
                if (!chained) return null;
                const added = this.addProxyToConfig(chained);
                return added && this.isUsableChainProxy(added) ? this.getProxyName(added) : null;
            };
            const manualName = addPath(this.chainEntryGroupName, this.t('chainManual'));
            if (!manualName) return;
            const members = [];

            if (this.includeAutoSelect) {
                // Each probe pins both hops, so switching entries never changes the landing.
                const candidates = this.chainEntryProxyNames
                    .map(entryName => addPath(entryName, `[${this.t('chainProxy')} · ${entryName}]`))
                    .filter(Boolean);
                if (candidates.length > 0) {
                    const autoName = this.reserveGroupName(`${this.t('chainAutoSelect')} · ${exitName}`);
                    this.addSelectorGroup(autoName, candidates, 'url-test');
                    this.chainAutoGroupNames.push(autoName);
                    members.push(autoName);
                }
            }
            members.push(manualName);
            const landingName = this.reserveGroupName(`${this.t('chainLanding')} · ${exitName}`);
            this.addSelectorGroup(landingName, members);
            this.chainLandingGroupNames.push(landingName);
        });
        if (this.chainLandingGroupNames.length === 0) {
            throw new InvalidPayloadError('Chain OUT source has no supported chain paths');
        }
        this.chainGroupName = this.reserveGroupName(this.t('chainGroup'));
        this.addSelectorGroup(this.chainGroupName, this.chainLandingGroupNames);
    }

    getProviderReferences() {
        return this.getAllProviderNames?.() ?? this.getAllProviderTags?.() ?? [];
    }

    getNodeSelectMembers(includeReject = true) {
        return buildNodeSelectMembers({
            ordinaryGroupName: this.ordinaryGroupName,
            chainGroupName: this.chainGroupName,
            includeReject
        });
    }

    getBusinessGroupMembers(includeReject = true) {
        return buildSelectorMembers({
            translator: this.t,
            ordinaryGroupName: this.ordinaryGroupName,
            chainGroupName: this.chainGroupName,
            sourceGroupNames: this.sourceGroupNames,
            includeReject
        });
    }

    addSelectors() {
        const outbounds = this.getOutboundsList();
        const proxyList = this.getOriginalProxies()
            .filter(proxy => this.isUsableChainProxy(proxy))
            .map(proxy => this.getProxyName(proxy));
        const providers = this.getProviderReferences();
        const hasNodes = proxyList.length > 0 || providers.length > 0;

        this.addAutoSelectGroup(proxyList);
        this.addSourceGroups();
        if (this.groupByCountry) this.addCountryGroups();
        if (hasNodes) this.addSelectorGroup(this.allNodesGroupName, proxyList, 'select', providers);
        const ordinaryMembers = buildOrdinaryMembers({
            autoGroupName: this.includeAutoSelect && hasNodes ? this.autoGroupName : undefined,
            allNodesGroupName: hasNodes ? this.allNodesGroupName : undefined,
            sourceGroupNames: this.sourceGroupNames,
            countryGroupNames: this.countryGroupNames
        });
        this.addSelectorGroup(this.ordinaryGroupName, ordinaryMembers.length > 0 ? ordinaryMembers : ['DIRECT']);
        this.addNodeSelectGroup();
        this.addOutboundGroups(outbounds);
        this.addCustomRuleGroups();
        this.addFallBackGroup();
    }

    orderGroups(groups, getName) {
        const names = [
            this.t('outboundNames.Node Select'),
            ...this.getOutboundsList().map(name => this.t(`outboundNames.${name}`)),
            ...(Array.isArray(this.customRules) ? this.customRules : []).map(rule => this.t(`outboundNames.${rule.name}`)),
            this.t('outboundNames.Fall Back'),
            this.ordinaryGroupName,
            this.chainGroupName,
            ...this.chainLandingGroupNames,
            this.chainEntryGroupName,
            this.allNodesGroupName,
            this.autoGroupName,
            ...this.sourceGroupNames,
            ...this.countryGroupNames,
            ...this.chainAutoGroupNames
        ];
        const ranks = new Map();
        names.forEach(name => {
            if (name && !ranks.has(name)) ranks.set(name, ranks.size);
        });
        return [...groups].sort((a, b) => (ranks.get(getName(a)) ?? ranks.size) - (ranks.get(getName(b)) ?? ranks.size));
    }

    getOriginalProxies() {
        if (!this.originalProxyNames) return this.getProxies();
        return this.getProxies().filter(proxy => this.originalProxyNames.has(this.getProxyName(proxy)));
    }

    generateRules() {
        return generateRules(this.selectedRules, this.customRules);
    }

    formatConfig() {
        throw new Error('formatConfig must be implemented in child class');
    }
}
