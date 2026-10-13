import { initializeConfig, applyConfigOverrides } from './helpers/configOverrides.js';
import { validateConfigReferences } from './helpers/configValidation.js';

import { SING_BOX_CONFIG, SING_BOX_CONFIG_V1_11, generateRuleSets, generateRules, getOutbounds, PREDEFINED_RULE_SETS, DIRECT_DEFAULT_RULES, REJECT_ACTION_RULES } from '../config/index.js';
import { BaseConfigBuilder } from './BaseConfigBuilder.js';
import { groupProxiesByCountry } from '../utils.js';
import { addProxyWithDedup } from './helpers/proxyHelpers.js';
import { uniqueNames } from './helpers/groupBuilder.js';
import { normalizeGroupName } from './helpers/groupNameUtils.js';

const RULE_SET_HTTP_CLIENT_TAG = 'rule-set-download';
const ANYTLS_OPTION_KEYS = {
    'idle-session-check-interval': 'idle_session_check_interval',
    'idle-session-timeout': 'idle_session_timeout',
    'min-idle-session': 'min_idle_session'
};

export class SingboxConfigBuilder extends BaseConfigBuilder {
    constructor(inputString, selectedRules, customRules, baseConfig, lang, userAgent, groupByCountry = false, enableClashUI = false, externalController, externalUiDownloadUrl, singboxVersion = '1.12', includeAutoSelect = true, chainConfig = null, autoSelectInterval) {
        const defaults = singboxVersion === '1.11' ? SING_BOX_CONFIG_V1_11 : SING_BOX_CONFIG;
        const resolvedBaseConfig = initializeConfig(defaults, baseConfig, 'singbox');
        super(inputString, resolvedBaseConfig, lang, userAgent, groupByCountry, includeAutoSelect, chainConfig, autoSelectInterval);

        this.configOverrides = baseConfig;
        this.configFormat = 'singbox';
        this.selectedRules = selectedRules;
        this.customRules = customRules;
        this.countryGroupNames = [];
        this.supportsReject = false;
        this.enableClashUI = enableClashUI;
        this.externalController = externalController;
        this.externalUiDownloadUrl = externalUiDownloadUrl;
        this.singboxVersion = singboxVersion;  // '1.11', '1.12' or '1.14'

        if (this.config?.dns?.servers?.length > 0) {
            this.config.dns.servers[0].detour = this.t('outboundNames.Node Select');
        }
    }

    /**
     * Check if subscription format is compatible for use as Sing-Box outbound_provider
     * Only available in Sing-Box 1.12+
     * @param {'clash'|'singbox'|'unknown'} format - Detected subscription format
     * @returns {boolean} - True if format is Sing-Box JSON and version supports providers
     */
    isCompatibleProviderFormat(format) {
        // outbound_providers only supported in Sing-Box 1.12+
        if (this.singboxVersion === '1.11') {
            return false;
        }
        return format === 'singbox';
    }

    /**
     * Generate outbound_providers configuration from collected URLs
     * @returns {object[]} - Array of outbound provider objects
     */
    generateOutboundProviders() {
        const existingTags = this.getExistingProviderTags();
        return this.getAutoProviderDescriptors(existingTags).map(({ name, url }) => ({
            tag: name,
            type: 'http',
            download_url: url,
            path: `./providers/${name}.json`,
            download_interval: '24h',
            health_check: {
                enabled: true,
                url: 'https://www.gstatic.com/generate_204',
                interval: `${this.autoSelectInterval}s`
            }
        }));
    }

    /**
     * Get list of provider tags
     * @returns {string[]} - Array of provider tags
     */
    getProviderTags() {
        return this.getAutoProviderDescriptors(this.getExistingProviderTags()).map(provider => provider.name);
    }

    getExistingProviderTags() {
        return Array.isArray(this.config.outbound_providers)
            ? this.config.outbound_providers.map(p => p?.tag).filter(Boolean)
            : [];
    }

    /**
     * Get all provider tags (user-defined + auto-generated)
     * @returns {string[]} - Array of provider tags
     */
    getAllProviderTags() {
        if (this.singboxVersion === '1.11') {
            return [];
        }
        const existingTags = this.getExistingProviderTags();
        const autoTags = this.getProviderTags();
        return [...new Set([...existingTags, ...autoTags])];
    }

    getProxies() {
        return this.config.outbounds.filter(outbound => outbound?.server != undefined);
    }

    getProxyName(proxy) {
        return proxy.tag;
    }

    convertProxy(proxy) {
        // Create a shallow copy to avoid mutating the original
        const sanitized = { ...proxy };

        // URI and Clash inputs use Mihomo's kebab-case names, while sing-box
        // rejects those keys and requires its native snake_case options.
        if (sanitized.type === 'anytls') {
            Object.entries(ANYTLS_OPTION_KEYS).forEach(([sourceKey, targetKey]) => {
                if (sanitized[sourceKey] !== undefined && sanitized[targetKey] === undefined) {
                    sanitized[targetKey] = sanitized[sourceKey];
                }
                delete sanitized[sourceKey];
            });
            // sing-box types the two idle intervals as Duration strings ("30s"),
            // while share links and Mihomo carry plain seconds
            ['idle_session_check_interval', 'idle_session_timeout'].forEach((key) => {
                if (typeof sanitized[key] === 'number') {
                    sanitized[key] = `${sanitized[key]}s`;
                }
            });
        }

        // Strip Clash-only / mis-typed fields that conflict with sing-box semantics.
        // `udp` is Clash-only. Top-level `network` in sing-box is a TCP/UDP allowlist
        // (NetworkList in option/types.go); a stray "tcp" silently disables UDP for
        // every group that selects this node — including DNS hijack and fakeip.
        delete sanitized.udp;
        delete sanitized.network;
        if (sanitized.tls?.reality?.support_x25519mlkem768 !== undefined) {
            const { support_x25519mlkem768: _mihomoOnly, ...reality } = sanitized.tls.reality;
            sanitized.tls = { ...sanitized.tls, reality };
        }

        // Remove 'alpn' from root level - it should only exist inside 'tls' object for sing-box
        // For protocols like vless/vmess, alpn belongs inside the tls configuration
        if (sanitized.alpn && sanitized.tls) {
            // Move alpn into tls if tls exists and doesn't have alpn
            if (!sanitized.tls.alpn) {
                sanitized.tls = { ...sanitized.tls, alpn: sanitized.alpn };
            }
            delete sanitized.alpn;
        } else if (sanitized.alpn && !sanitized.tls) {
            // No TLS, remove alpn entirely
            delete sanitized.alpn;
        }

        // Remove packet_encoding for now - it's version-specific in sing-box
        // xudp is default in newer versions
        delete sanitized.packet_encoding;

        if (sanitized.type === 'hysteria2') {
            // sing-box names port-hopping/bandwidth fields differently from the
            // share-link shape, and rejects unknown fields outright
            if (sanitized.ports) {
                const ranges = String(sanitized.ports).split(',')
                    .map(range => range.trim().replace('-', ':'))
                    .filter(Boolean);
                if (ranges.length > 0) {
                    sanitized.server_ports = ranges;
                }
                delete sanitized.ports;
            }
            if (typeof sanitized.hop_interval === 'number') {
                sanitized.hop_interval = `${sanitized.hop_interval}s`;
            }
            if (sanitized.up !== undefined) {
                sanitized.up_mbps = sanitized.up;
                delete sanitized.up;
            }
            if (sanitized.down !== undefined) {
                sanitized.down_mbps = sanitized.down;
                delete sanitized.down;
            }
            delete sanitized.auth;
            delete sanitized.recv_window_conn;
            delete sanitized.fast_open;
        }

        return sanitized;
    }

    addProxyToConfig(proxy) {
        this.config.outbounds = this.config.outbounds || [];
        return addProxyWithDedup(this.config.outbounds, proxy, {
            getName: (item) => item?.tag,
            setName: (item, name) => {
                if (item) item.tag = name;
            },
            isSame: (existing = {}, incoming = {}) => {
                const { tag: _incomingTag, ...restIncoming } = incoming;
                const { tag: _existingTag, ...restExisting } = existing;
                return JSON.stringify(restIncoming) === JSON.stringify(restExisting);
            }
        });
    }

    hasConfigGroup(name) {
        return this.hasOutboundTag(name);
    }

    addSelectorGroup(name, members, type = 'select', providers = []) {
        this.config.outbounds.push({
            type: type === 'url-test' ? 'urltest' : 'selector',
            tag: name,
            outbounds: uniqueNames(members),
            ...(providers.length > 0 ? { providers } : {}),
            ...(type === 'url-test' ? { url: 'https://www.gstatic.com/generate_204', interval: `${this.autoSelectInterval}s`, tolerance: 50 } : {})
        });
    }

    applyChainToProxy(proxy, entryGroupName) {
        return { ...proxy, detour: entryGroupName };
    }

    hasOutboundTag(tag) {
        const target = normalizeGroupName(tag);
        return (this.config.outbounds || []).some(outbound => normalizeGroupName(outbound?.tag) === target);
    }

    addOutboundGroups(outbounds) {
        outbounds.forEach(outbound => {
            if (outbound !== this.t('outboundNames.Node Select')) {
                if (REJECT_ACTION_RULES.has(outbound)) return;
                let selectorMembers = this.getBusinessGroupMembers(false);
                const tag = this.t(`outboundNames.${outbound}`);
                if (this.hasOutboundTag(tag)) {
                    return;
                }
                // For rules that should default to DIRECT, move DIRECT to the front
                if (DIRECT_DEFAULT_RULES.has(outbound)) {
                    selectorMembers = ['DIRECT', ...selectorMembers.filter(p => p !== 'DIRECT')];
                }
                this.config.outbounds.push({
                    type: "selector",
                    tag,
                    outbounds: selectorMembers
                });
            }
        });
    }

    addCustomRuleGroups() {
        if (Array.isArray(this.customRules)) {
            this.customRules.forEach(rule => {
                const selectorMembers = this.getBusinessGroupMembers(false);
                if (this.hasOutboundTag(rule.name)) return;
                this.config.outbounds.push({
                    type: "selector",
                    tag: rule.name,
                    outbounds: selectorMembers
                });
            });
        }
    }

    addFallBackGroup() {
        const selectorMembers = this.getBusinessGroupMembers(false);
        if (this.hasOutboundTag(this.t('outboundNames.Fall Back'))) return;
        this.config.outbounds.push({
            type: "selector",
            tag: this.t('outboundNames.Fall Back'),
            outbounds: selectorMembers
        });
    }

    addCountryGroups() {
        const proxies = this.getOriginalProxies();
        const countryGroups = groupProxiesByCountry(proxies, {
            getName: proxy => this.getProxyName(proxy)
        });

        const existingTags = new Set((this.config.outbounds || []).map(o => normalizeGroupName(o?.tag)).filter(Boolean));

        const countries = Object.keys(countryGroups).sort((a, b) => a.localeCompare(b));
        const countryGroupNames = [];

        countries.forEach(country => {
            const { emoji, name, proxies: countryProxies } = countryGroups[country];
            if (!countryProxies || countryProxies.length === 0) {
                return;
            }
            const groupName = this.reserveGroupName(`${emoji} ${name}`);
            const norm = normalizeGroupName(groupName);
            if (!existingTags.has(norm)) {
                this.config.outbounds.push({
                    tag: groupName,
                    type: this.includeAutoSelect ? 'urltest' : 'selector',
                    ...(this.includeAutoSelect ? { interval: `${this.autoSelectInterval}s` } : {}),
                    outbounds: countryProxies
                });
                existingTags.add(norm);
            }
            countryGroupNames.push(groupName);
        });

        this.countryGroupNames = countryGroupNames;
    }

    /**
     * Validate outbounds before final output
     * Ensures urltest groups have outbounds, fills empty ones with all proxy tags
     */
    validateOutbounds() {
        const proxyList = this.getProxyList();
        const providerTags = this.getAllProviderTags();
        const invalidTags = new Set();

        (this.config.outbounds || []).forEach(outbound => {
            // For urltest groups, ensure they have outbounds or providers
            if (outbound.type === 'urltest' &&
                (!outbound.outbounds || outbound.outbounds.length === 0) &&
                (!outbound.providers || outbound.providers.length === 0)) {
                // Fill with all available proxy tags
                outbound.outbounds = [...proxyList];
                // Also use all providers if available
                if (providerTags.length > 0) {
                    outbound.providers = [...providerTags];
                }
                if ((!outbound.outbounds || outbound.outbounds.length === 0) &&
                    (!outbound.providers || outbound.providers.length === 0)) {
                    invalidTags.add(normalizeGroupName(outbound.tag));
                }
            }
        });

        if (invalidTags.size > 0) {
            this.config.outbounds = (this.config.outbounds || [])
                .filter(outbound => !invalidTags.has(normalizeGroupName(outbound?.tag)))
                .map(outbound => {
                    if (Array.isArray(outbound.outbounds)) {
                        outbound.outbounds = outbound.outbounds.filter(tag => !invalidTags.has(normalizeGroupName(tag)));
                    }
                    return outbound;
                });
        }
    }

    sanitizeLegacySpecialOutbounds(removeEmptyGroups = true) {
        const legacyTags = new Set(
            (this.config.outbounds || [])
                .filter(outbound => outbound?.type === 'block' || outbound?.type === 'dns')
                .map(outbound => normalizeGroupName(outbound?.tag))
                .filter(Boolean)
        );
        legacyTags.add(normalizeGroupName('REJECT'));

        this.config.outbounds = (this.config.outbounds || [])
            .filter(outbound => !legacyTags.has(normalizeGroupName(outbound?.tag)))
            .map(outbound => {
                if (Array.isArray(outbound.outbounds)) {
                    outbound.outbounds = outbound.outbounds.filter(tag => !legacyTags.has(normalizeGroupName(tag)));
                }
                return outbound;
            })
            .filter(outbound => {
                if (!removeEmptyGroups || (outbound?.type !== 'selector' && outbound?.type !== 'urltest')) return true;
                return outbound.outbounds?.length > 0 || outbound.providers?.length > 0;
            });
    }

    buildRouteTarget(rule) {
        if (REJECT_ACTION_RULES.has(rule?.outbound) || rule?.outbound === 'REJECT') {
            return { action: 'reject' };
        }
        return { outbound: this.t(`outboundNames.${rule.outbound}`) };
    }

    /**
     * Pin remote rule-set downloads to DIRECT so fetching never depends on a
     * proxy that may not be up yet (issue #408). sing-box 1.14 deprecates both
     * the implicit default HTTP client and the download_detour field (removed
     * in 1.16, issue #401), so >=1.14 gets an explicit shared HTTP client
     * while older versions get the legacy per-rule-set field.
     */
    configureRuleSetDownload() {
        if (this.singboxVersion === '1.14') {
            if (this.config.route.default_http_client) {
                return;
            }
            if (!Array.isArray(this.config.http_clients) || this.config.http_clients.length === 0) {
                this.config.http_clients = [{ tag: RULE_SET_HTTP_CLIENT_TAG, detour: 'DIRECT' }];
            }
            this.config.route.default_http_client = this.config.http_clients[0].tag;
            return;
        }
        this.config.route.rule_set.forEach(ruleSet => {
            if (ruleSet?.type === 'remote' && !ruleSet.download_detour) {
                ruleSet.download_detour = 'DIRECT';
            }
        });
    }

    formatConfig() {
        if (this.formattedConfig !== undefined) return this.formattedConfig;
        const rules = generateRules(this.selectedRules, this.customRules);
        const { site_rule_sets, ip_rule_sets } = generateRuleSets(this.selectedRules, this.customRules);

        this.config.route.rule_set = [...site_rule_sets, ...ip_rule_sets];
        this.configureRuleSetDownload();

        // Add outbound_providers if we have any
        if (this.providerUrls.length > 0) {
            const existingProviders = Array.isArray(this.config.outbound_providers) ? this.config.outbound_providers : [];
            const newProviders = this.generateOutboundProviders();
            this.config.outbound_providers = [...existingProviders, ...newProviders];
        }

        // Validate outbounds: fill empty urltest groups with all proxies
        this.validateOutbounds();
        this.sanitizeLegacySpecialOutbounds();

        const attachProtocolIfNeeded = (entry, rule) => {
            if (Array.isArray(rule?.protocol) && rule.protocol.length > 0) {
                entry.protocol = rule.protocol;
            }
            return entry;
        };

        const hasMatchValues = (value) => {
            if (Array.isArray(value)) return value.length > 0;
            if (typeof value === 'string') return value.trim() !== '';
            return false;
        };

        rules.filter(rule => Array.isArray(rule.src_ip_cidr) && rule.src_ip_cidr.length > 0).map(rule => {
            this.config.route.rules.push(attachProtocolIfNeeded({
                source_ip_cidr: rule.src_ip_cidr,
                ...this.buildRouteTarget(rule)
            }, rule));
        });

        rules.filter(rule => hasMatchValues(rule.domain_suffix) || hasMatchValues(rule.domain_keyword)).map(rule => {
            const entry = {
                ...this.buildRouteTarget(rule)
            };

            if (hasMatchValues(rule.domain_suffix)) entry.domain_suffix = rule.domain_suffix;
            if (hasMatchValues(rule.domain_keyword)) entry.domain_keyword = rule.domain_keyword;

            this.config.route.rules.push(attachProtocolIfNeeded(entry, rule));
        });

        rules.filter(rule => !!rule.site_rules[0]).map(rule => {
            this.config.route.rules.push(attachProtocolIfNeeded({
                rule_set: [
                    ...(rule.site_rules.length > 0 && rule.site_rules[0] !== '' ? rule.site_rules : []),
                ],
                ...this.buildRouteTarget(rule)
            }, rule));
        });

        rules.filter(rule => !!rule.ip_rules[0]).map(rule => {
            this.config.route.rules.push(attachProtocolIfNeeded({
                rule_set: [
                    ...(rule.ip_rules
                        .map(ip => ip.trim())
                        .filter(ip => ip !== '')
                        .map(ip => `${ip}-ip`))
                ],
                ...this.buildRouteTarget(rule)
            }, rule));
        });

        rules.filter(rule => hasMatchValues(rule.ip_cidr)).map(rule => {
            this.config.route.rules.push(attachProtocolIfNeeded({
                ip_cidr: rule.ip_cidr,
                ...this.buildRouteTarget(rule)
            }, rule));
        });

        // Order matters: sniff first so downstream rules can match on protocol;
        // hijack-dns before clash_mode so DNS never escapes into a selector when
        // the user toggles global mode (selectors only support TCP+UDP if the
        // currently selected node does, which is fragile).
        this.config.route.rules.unshift(
            { action: 'sniff' },
            { protocol: 'dns', action: 'hijack-dns' },
            { clash_mode: 'direct', outbound: 'DIRECT' },
            { clash_mode: 'global', outbound: this.t('outboundNames.Node Select') }
        );

        this.config.route.auto_detect_interface = true;
        this.config.route.final = this.t('outboundNames.Fall Back');
        this.config = applyConfigOverrides(this.config, this.configOverrides, 'singbox');
        this.sanitizeLegacySpecialOutbounds(false);
        this.configureRuleSetDownload();
        // 如果启用了 Clash UI，添加配置
        // 如果启用 Clash UI 或传入了自定义参数，添加/覆盖 Clash API 配置
        if (this.enableClashUI || this.externalController || this.externalUiDownloadUrl) {
            const defaultExternalController = "0.0.0.0:9090";
            const defaultExternalUiDownloadUrl = "https://gh-proxy.com/https://github.com/Zephyruso/zashboard/archive/refs/heads/gh-pages.zip";
            const defaultExternalUi = "./ui";
            const defaultSecret = "";
            const defaultDownloadDetour = "DIRECT";
            const defaultClashMode = "rule";

            this.config.experimental = this.config.experimental || {};
            const existingClashApi = this.config.experimental.clash_api || {};

            const externalController = this.externalController || existingClashApi.external_controller || defaultExternalController;
            const externalUiDownloadUrl = this.externalUiDownloadUrl || existingClashApi.external_ui_download_url || defaultExternalUiDownloadUrl;
            const externalUi = existingClashApi.external_ui || defaultExternalUi;
            const secret = existingClashApi.secret ?? defaultSecret;
            const externalUiDownloadDetour = existingClashApi.external_ui_download_detour || defaultDownloadDetour;
            const clashMode = existingClashApi.default_mode || defaultClashMode;

            this.config.experimental.clash_api = {
                ...existingClashApi,
                external_controller: externalController,
                external_ui: externalUi,
                external_ui_download_url: externalUiDownloadUrl,
                external_ui_download_detour: externalUiDownloadDetour,
                secret,
                default_mode: clashMode
            };
        }
        validateConfigReferences(this.config, 'singbox', this.singboxVersion);
        this.config.outbounds = this.orderGroups(this.config.outbounds, outbound => outbound.tag);
        this.formattedConfig = this.config;
        return this.formattedConfig;
    }
}
