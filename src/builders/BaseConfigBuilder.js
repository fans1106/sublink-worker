import { ProxyParser } from '../parsers/index.js';
import { createStableProviderName, deepCopy, tryDecodeSubscriptionLines, decodeBase64 } from '../utils.js';
import { createTranslator } from '../i18n/index.js';
import { generateRules, getOutbounds, PREDEFINED_RULE_SETS } from '../config/index.js';
import { InvalidPayloadError } from '../services/errors.js';

export class BaseConfigBuilder {
    constructor(inputString, baseConfig, lang, userAgent, groupByCountry = false, includeAutoSelect = true, chainConfig = null) {
        this.inputString = inputString;
        this.config = deepCopy(baseConfig);
        this.customRules = [];
        this.selectedRules = [];
        this.t = createTranslator(lang);
        this.userAgent = userAgent;
        this.appliedOverrideKeys = new Set();
        this.groupByCountry = groupByCountry;
        this.includeAutoSelect = includeAutoSelect;
        this.providerUrls = [];  // URLs to use as providers (auto-sync)
        this.providerNodeNames = [];  // node names from provider subscriptions, for country enumeration only
        this.autoProviderDescriptors = undefined;
        this.subscriptionUserinfo = undefined;
        this.chainConfig = chainConfig;
        this.chainSourcesByLine = new Map((chainConfig?.sources || []).map(source => [source.line, source]));
        this.chainedSourceIds = new Set((chainConfig?.links || []).flatMap(link => [link.entry.id, link.exit.id]));
        this.proxySourceIds = new WeakMap();
        this.sourceItems = new Map();
        this.sourceProxyNames = new Map();
        this.chainGroupNames = [];
        this.chainReservedNames = new Set();
    }

    async build() {
        const customItems = await this.parseCustomItems();
        this.addCustomItems(customItems);
        this.originalProxyNames = new Set(this.getProxyList());
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
            if (directResult.config) {
                this.applyConfigOverrides(directResult.config);
            }
            if (Array.isArray(directResult.proxies)) {
                for (const proxy of directResult.proxies) {
                    if (proxy && proxy.tag) {
                        parsedItems.push(proxy);
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
                        if (decodedResult.config) {
                            this.applyConfigOverrides(decodedResult.config);
                        }
                        if (Array.isArray(decodedResult.proxies)) {
                            for (const proxy of decodedResult.proxies) {
                                if (proxy && proxy.tag) {
                                    parsedItems.push(proxy);
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

                // Check if it's an HTTP(S) URL - may use as provider if format matches
                if (trimmedUrl.startsWith('http://') || trimmedUrl.startsWith('https://')) {
                    const { fetchSubscriptionWithFormat } = await import('../parsers/subscription/httpSubscriptionFetcher.js');

                    try {
                        const fetchResult = await fetchSubscriptionWithFormat(trimmedUrl, this.userAgent);
                        if (fetchResult) {
                            const { content, format, url: originalUrl, subscriptionUserinfo } = fetchResult;

                            if (subscriptionUserinfo && !this.subscriptionUserinfo) {
                                this.subscriptionUserinfo = subscriptionUserinfo;
                            }

                            // If format is compatible with target client, use as provider
                            if (!this.chainedSourceIds.has(sourceId) && this.isCompatibleProviderFormat(format)) {
                                this.providerUrls.push(originalUrl);
                                // Content is already fetched; keep node names so country
                                // groups can be built over provider members later.
                                await this.collectProviderNodeNames(content);
                                continue;  // Skip parsing, will be used as provider
                            }

                            // Otherwise parse the content as usual
                            const result = parseSubscriptionContent(content);
                            if (result && typeof result === 'object' && (result.type === 'yamlConfig' || result.type === 'singboxConfig' || result.type === 'surgeConfig')) {
                                if (result.config) {
                                    this.applyConfigOverrides(result.config);
                                }
                                if (Array.isArray(result.proxies)) {
                                    result.proxies.forEach(proxy => {
                                        if (proxy && typeof proxy === 'object' && proxy.tag) {
                                            this.recordParsedItem(parsedItems, proxy, sourceId);
                                        }
                                    });
                                }
                                continue;
                            }
                            // Handle array of URIs or other formats
                            if (Array.isArray(result)) {
                                for (const item of result) {
                                    if (item && typeof item === 'object' && item.tag) {
                                        this.recordParsedItem(parsedItems, item, sourceId);
                                    } else if (typeof item === 'string') {
                                        const subResult = await ProxyParser.parse(item, this.userAgent);
                                        if (subResult) {
                                            this.recordParsedItem(parsedItems, subResult, sourceId);
                                        }
                                    }
                                }
                            }
                        }
                    } catch (error) {
                        console.error('Error processing HTTP subscription:', error);
                    }
                    continue;
                }

                // Non-HTTP URLs (protocol URIs like ss://, vmess://, etc.)
                const result = await ProxyParser.parse(processedUrl, this.userAgent);
                // Handle yamlConfig, singboxConfig, and surgeConfig types (they have the same structure)
                if (result && typeof result === 'object' && (result.type === 'yamlConfig' || result.type === 'singboxConfig' || result.type === 'surgeConfig')) {
                    if (result.config) {
                        this.applyConfigOverrides(result.config);
                    }
                    if (Array.isArray(result.proxies)) {
                        result.proxies.forEach(proxy => {
                            if (proxy && typeof proxy === 'object' && proxy.tag) {
                                this.recordParsedItem(parsedItems, proxy, sourceId);
                            }
                        });
                    }
                    continue;
                }
                if (Array.isArray(result)) {
                    for (const item of result) {
                        if (item && typeof item === 'object' && item.tag) {
                            this.recordParsedItem(parsedItems, item, sourceId);
                        } else if (typeof item === 'string') {
                            const subResult = await ProxyParser.parse(item, this.userAgent);
                            if (subResult) {
                                this.recordParsedItem(parsedItems, subResult, sourceId);
                            }
                        }
                    }
                } else if (result) {
                    this.recordParsedItem(parsedItems, result, sourceId);
                }
            }
        }

        return parsedItems;
    }

    recordParsedItem(parsedItems, item, sourceId) {
        if (!item) return;
        if (Array.isArray(item)) {
            item.forEach(child => this.recordParsedItem(parsedItems, child, sourceId));
            return;
        }
        parsedItems.push(item);
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

    applyConfigOverrides(overrides) {
        if (!overrides || typeof overrides !== 'object') {
            return;
        }

        // Block keys that are handled specially:
        // - 'proxies': handled by dedicated parser
        // - 'rules', 'rule-providers': generated by our own logic
        // - 'proxy-groups': stored for later intelligent merge (not direct override)
        const blacklistedKeys = new Set(['proxies', 'rules', 'rule-providers', 'proxy-groups']);

        Object.entries(overrides).forEach(([key, value]) => {
            if (blacklistedKeys.has(key)) {
                return;
            }
            if (value === undefined) {
                delete this.config[key];
                this.appliedOverrideKeys.add(key);
            } else if (key === 'dns' && typeof value === 'object' && !Array.isArray(value)) {
                // Special handling for dns object - merge array fields instead of overwriting
                this.config[key] = this.mergeDnsConfig(this.config[key], value);
                this.appliedOverrideKeys.add(key);
            } else {
                this.config[key] = deepCopy(value);
                this.appliedOverrideKeys.add(key);
            }
        });

        // Store user proxy-groups for later merge (after system groups are created)
        if (Array.isArray(overrides['proxy-groups'])) {
            this.pendingUserProxyGroups = this.pendingUserProxyGroups || [];
            this.pendingUserProxyGroups.push(...overrides['proxy-groups']);
        }
    }

    /**
     * Merge DNS configuration with intelligent array merging
     * Arrays like nameserver, fallback, fake-ip-filter are merged instead of overwritten
     * @param {object} existing - Existing DNS config
     * @param {object} incoming - Incoming DNS config to merge
     * @returns {object} - Merged DNS config
     */
    mergeDnsConfig(existing, incoming) {
        if (!existing || typeof existing !== 'object') {
            return deepCopy(incoming);
        }

        const result = deepCopy(existing);
        // Array fields that should be merged instead of overwritten
        const mergeableArrayKeys = new Set(['nameserver', 'fallback', 'fake-ip-filter']);

        Object.entries(incoming).forEach(([key, value]) => {
            if (mergeableArrayKeys.has(key) && Array.isArray(value)) {
                if (Array.isArray(result[key])) {
                    // Merge arrays and deduplicate
                    result[key] = [...new Set([...result[key], ...value])];
                } else {
                    result[key] = deepCopy(value);
                }
            } else if (key === 'nameserver-policy' && typeof value === 'object' && !Array.isArray(value)) {
                // Merge nameserver-policy object
                result[key] = { ...(result[key] || {}), ...deepCopy(value) };
            } else {
                result[key] = deepCopy(value);
            }
        });

        return result;
    }

    hasConfigOverride(key) {
        return this.appliedOverrideKeys?.has(key);
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
        throw new Error('addAutoSelectGroup must be implemented in child class');
    }

    addNodeSelectGroup(proxyList) {
        throw new Error('addNodeSelectGroup must be implemented in child class');
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
                const convertedProxy = this.convertProxy(item);
                if (convertedProxy) {
                    const addedProxy = this.addProxyToConfig(convertedProxy);
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

    createChainGroup() {
        throw new Error('createChainGroup must be implemented in child class');
    }

    applyChainToProxy() {
        throw new Error('applyChainToProxy must be implemented in child class');
    }

    reserveChainName(baseName) {
        const usedProxyNames = new Set(this.getProxyList());
        let name = baseName;
        let suffix = 2;
        while (usedProxyNames.has(name) || this.hasConfigGroup(name) || this.chainReservedNames.has(name)) {
            name = `${baseName} ${suffix}`;
            suffix += 1;
        }
        this.chainReservedNames.add(name);
        return name;
    }

    addChains() {
        if (!this.chainConfig?.links?.length) return;

        const entryGroups = new Map();
        this.chainConfig.links.forEach(link => {
            if (!entryGroups.has(link.entry.id)) {
                const members = this.sourceProxyNames.get(link.entry.id) || [];
                if (members.length === 0) {
                    throw new InvalidPayloadError(`Chain entry subscription has no supported proxies: ${link.entry.label}`);
                }
                const groupName = this.reserveChainName(`🔗 IN · ${link.entry.label}`);
                this.createChainGroup(groupName, members);
                entryGroups.set(link.entry.id, groupName);
            }

            const exitItems = this.sourceItems.get(link.exit.id) || [];
            if (exitItems.length === 0) {
                throw new InvalidPayloadError(`Chain exit subscription has no supported proxies: ${link.exit.label}`);
            }

            const entryGroupName = entryGroups.get(link.entry.id);
            const chainedNames = [];
            exitItems.forEach(item => {
                const cloned = deepCopy(item);
                cloned.tag = this.reserveChainName(`[${link.entry.label} → ${link.exit.label}] ${item.tag}`);
                const converted = this.convertProxy(cloned);
                const chained = converted && this.applyChainToProxy(converted, entryGroupName);
                if (!chained) return;
                const added = this.addProxyToConfig(chained);
                if (added && this.isUsableChainProxy(added)) {
                    const name = this.getProxyName(added);
                    if (name) chainedNames.push(name);
                }
            });

            if (chainedNames.length === 0) {
                throw new InvalidPayloadError(`Chain exit subscription has no supported proxies: ${link.exit.label}`);
            }
            const chainGroupName = this.reserveChainName(`🔗 ${link.entry.label} → ${link.exit.label}`);
            this.createChainGroup(chainGroupName, chainedNames);
            this.chainGroupNames.push(chainGroupName);
        });
    }

    withChainGroups(options = []) {
        if (this.chainGroupNames.length === 0) return options;
        const insertAt = options.findIndex(option => option === 'DIRECT' || option === 'REJECT');
        const index = insertAt === -1 ? options.length : insertAt;
        return [
            ...options.slice(0, index),
            ...this.chainGroupNames.filter(name => !options.includes(name)),
            ...options.slice(index)
        ];
    }

    addSelectors() {
        const outbounds = this.getOutboundsList();
        const proxyList = this.originalProxyNames ? [...this.originalProxyNames] : this.getProxyList();

        this.addAutoSelectGroup(proxyList);
        this.addNodeSelectGroup(proxyList);
        if (this.groupByCountry) {
            this.addCountryGroups();
        }
        this.addOutboundGroups(outbounds, proxyList);
        this.addCustomRuleGroups(proxyList);
        this.addFallBackGroup(proxyList);

        // Merge user-defined proxy-groups after system groups are created
        if (this.pendingUserProxyGroups && this.pendingUserProxyGroups.length > 0) {
            this.mergeUserProxyGroups(this.pendingUserProxyGroups);
        }
    }

    getOriginalProxies() {
        if (!this.originalProxyNames) return this.getProxies();
        return this.getProxies().filter(proxy => this.originalProxyNames.has(this.getProxyName(proxy)));
    }

    /**
     * Merge user-defined proxy groups with system-generated ones
     * Override in child classes to implement format-specific merge logic
     * @param {Array} userGroups - User-defined proxy groups
     */
    mergeUserProxyGroups(userGroups) {
        // Default: no-op. Child classes implement format-specific merge.
    }

    generateRules() {
        return generateRules(this.selectedRules, this.customRules);
    }

    formatConfig() {
        throw new Error('formatConfig must be implemented in child class');
    }
}
