import { initializeConfig, applyConfigOverrides } from './helpers/configOverrides.js';
import { validateConfigReferences } from './helpers/configValidation.js';
import yaml from 'js-yaml';
import { CLASH_CONFIG, generateRules, generateClashRuleSets, getOutbounds, PREDEFINED_RULE_SETS, DIRECT_DEFAULT_RULES } from '../config/index.js';
import { BaseConfigBuilder } from './BaseConfigBuilder.js';
import { groupProxiesByCountry, buildCountryNameFilter } from '../utils.js';
import { addProxyWithDedup } from './helpers/proxyHelpers.js';
import { uniqueNames } from './helpers/groupBuilder.js';
import { emitClashRules, sanitizeClashProxyGroups } from './helpers/clashConfigUtils.js';
import { normalizeGroupName } from './helpers/groupNameUtils.js';
import { InvalidConfigError } from '../services/errors.js';

/**
 * Check if the client supports MRS (Meta Rule Set) format
 * MRS is a binary format supported by Clash Meta/mihomo
 * Legacy Clash clients need YAML format instead
 * @param {string} userAgent - Client User-Agent string
 * @returns {boolean} - True if client supports MRS format
 */
function supportsMrsFormat(userAgent) {
    if (!userAgent) return true; // Default to mrs for unknown clients
    const ua = userAgent.toLowerCase();
    
    // Clients confirmed to support MRS format (Clash Meta/mihomo based)
    if (ua.includes('mihomo') || 
        ua.includes('meta') ||           // clash.meta, clashx meta, meta-for-android, etc.
        ua.includes('clash-verge') ||
        ua.includes('stash') ||
        ua.includes('verge')) {
        return true;
    }
    
    // Legacy clients that don't support MRS format
    if (ua.includes('merlin') ||
        ua.includes('clashforwindows') ||
        ua.includes('clashforandroid') ||
        ua.includes('clash/')) {         // 老版本Clash核心 (Clash/v1.x.x)
        return false;
    }
    
    // Default: use mrs for unknown clients (most modern clients support it)
    return true;
}

function getClashUdpValue(proxy, defaultEnabled = true) {
    if (typeof proxy?.udp !== 'undefined') {
        return proxy.udp;
    }
    return defaultEnabled;
}

export class ClashConfigBuilder extends BaseConfigBuilder {
    constructor(inputString, selectedRules, customRules, baseConfig, lang, userAgent, groupByCountry = false, enableClashUI = false, externalController, externalUiDownloadUrl, includeAutoSelect = true, chainConfig = null, autoSelectInterval) {
        super(inputString, initializeConfig(CLASH_CONFIG, baseConfig, 'clash'), lang, userAgent, groupByCountry, includeAutoSelect, chainConfig, autoSelectInterval);
        this.configOverrides = baseConfig;
        this.configFormat = 'clash';
        this.selectedRules = selectedRules;
        this.customRules = customRules;
        this.countryGroupNames = [];
        this.enableClashUI = enableClashUI;
        this.externalController = externalController;
        this.externalUiDownloadUrl = externalUiDownloadUrl;
    }

    /**
     * Check if subscription format is compatible for use as Clash proxy-provider
     * @param {'clash'|'singbox'|'unknown'} format - Detected subscription format
     * @returns {boolean} - True if format is Clash YAML
     */
    isCompatibleProviderFormat(format) {
        return format === 'clash';
    }

    /**
     * Generate proxy-providers configuration from collected URLs
     * @returns {object} - proxy-providers object
     */
    generateProxyProviders() {
        const providers = {};
        const existingProviders = this.getExistingProviderNames();
        this.getAutoProviderDescriptors(existingProviders).forEach(({ name, url }) => {
            providers[name] = {
                type: 'http',
                url: url,
                path: `./proxy_providers/${name}.yaml`,
                interval: 3600,
                'health-check': {
                    enable: true,
                    url: 'https://www.gstatic.com/generate_204',
                    interval: this.autoSelectInterval,
                    timeout: 5000,
                    lazy: true
                }
            };
        });
        return providers;
    }

    /**
     * Get list of provider names
     * @returns {string[]} - Array of provider names
     */
    getProviderNames() {
        return this.getAutoProviderDescriptors(this.getExistingProviderNames()).map(provider => provider.name);
    }

    getExistingProviderNames() {
        return this.config?.['proxy-providers'] && typeof this.config['proxy-providers'] === 'object'
            ? Object.keys(this.config['proxy-providers'])
            : [];
    }

    /**
     * Get all provider names (user-defined + auto-generated)
     * @returns {string[]} - Array of provider names
     */
    getAllProviderNames() {
        const existingProviders = this.getExistingProviderNames();
        const autoProviders = this.getProviderNames();
        return [...new Set([...existingProviders, ...autoProviders])];
    }

    getProxies() {
        return this.config.proxies || [];
    }

    getProxyName(proxy) {
        return proxy.name;
    }

    convertProxy(proxy) {
        switch (proxy.type) {
            case 'shadowsocks':
                return {
                    name: proxy.tag,
                    type: 'ss',
                    server: proxy.server,
                    port: proxy.server_port,
                    cipher: proxy.method,
                    password: proxy.password,
                    udp: getClashUdpValue(proxy),
                    ...(proxy.plugin ? { plugin: proxy.plugin } : {}),
                    ...(proxy.plugin_opts ? { 'plugin-opts': proxy.plugin_opts } : {})
                };
            case 'vmess':
                return {
                    name: proxy.tag,
                    type: proxy.type,
                    server: proxy.server,
                    port: proxy.server_port,
                    uuid: proxy.uuid,
                    alterId: proxy.alter_id ?? 0,
                    cipher: proxy.security,
                    tls: proxy.tls?.enabled || false,
                    servername: proxy.tls?.server_name || '',
                    'skip-cert-verify': !!proxy.tls?.insecure,
                    network: proxy.transport?.type || proxy.network || 'tcp',
                    'ws-opts': proxy.transport?.type === 'ws'
                        ? {
                            path: proxy.transport.path,
                            headers: proxy.transport.headers
                        }
                        : undefined,
                    'http-opts': proxy.transport?.type === 'http'
                        ? (() => {
                            const opts = {
                                method: proxy.transport.method || 'GET',
                                path: Array.isArray(proxy.transport.path) ? proxy.transport.path : [proxy.transport.path || '/'],
                            };
                            if (proxy.transport.headers && Object.keys(proxy.transport.headers).length > 0) {
                                opts.headers = proxy.transport.headers;
                            }
                            return opts;
                        })()
                        : undefined,
                    'grpc-opts': proxy.transport?.type === 'grpc'
                        ? {
                            'grpc-service-name': proxy.transport.service_name
                        }
                        : undefined,
                    'h2-opts': proxy.transport?.type === 'h2'
                        ? {
                            path: proxy.transport.path,
                            host: proxy.transport.host
                        }
                        : undefined,
                    udp: getClashUdpValue(proxy)
                };
            case 'vless':
                return {
                    name: proxy.tag,
                    type: proxy.type,
                    server: proxy.server,
                    port: proxy.server_port,
                    uuid: proxy.uuid,
                    cipher: proxy.security,
                    tls: proxy.tls?.enabled || false,
                    'client-fingerprint': proxy.tls?.utls?.fingerprint,
                    servername: proxy.tls?.server_name || '',
                    network: proxy.transport?.type || 'tcp',
                    'ws-opts': proxy.transport?.type === 'ws' ? {
                        path: proxy.transport.path,
                        headers: proxy.transport.headers
                    } : undefined,
                    'reality-opts': proxy.tls?.reality?.enabled ? {
                        'public-key': proxy.tls.reality.public_key,
                        'short-id': proxy.tls.reality.short_id,
                        ...(proxy.tls.reality.support_x25519mlkem768 !== undefined
                            ? { 'support-x25519mlkem768': proxy.tls.reality.support_x25519mlkem768 }
                            : {})
                    } : undefined,
                    'grpc-opts': proxy.transport?.type === 'grpc' ? {
                        'grpc-service-name': proxy.transport.service_name,
                    } : undefined,
                    tfo: proxy.tcp_fast_open,
                    'skip-cert-verify': !!proxy.tls?.insecure,
                    udp: getClashUdpValue(proxy),
                    ...(proxy.alpn ? { alpn: proxy.alpn } : {}),
                    ...(proxy.packet_encoding ? { 'packet-encoding': proxy.packet_encoding } : {}),
                    'flow': proxy.flow ?? undefined,
                };
            case 'hysteria2':
                return {
                    name: proxy.tag,
                    type: proxy.type,
                    server: proxy.server,
                    port: proxy.server_port,
                    ...(proxy.ports ? { ports: proxy.ports } : {}),
                    obfs: proxy.obfs?.type,
                    'obfs-password': proxy.obfs?.password,
                    password: proxy.password,
                    auth: proxy.auth,
                    up: proxy.up,
                    down: proxy.down,
                    'recv-window-conn': proxy.recv_window_conn,
                    sni: proxy.tls?.server_name || '',
                    'skip-cert-verify': !!proxy.tls?.insecure,
                    ...(proxy.hop_interval !== undefined ? { 'hop-interval': proxy.hop_interval } : {}),
                    ...(proxy.alpn ? { alpn: proxy.alpn } : {}),
                    ...(proxy.fast_open !== undefined ? { 'fast-open': proxy.fast_open } : {}),
                };
            case 'trojan':
                return {
                    name: proxy.tag,
                    type: proxy.type,
                    server: proxy.server,
                    port: proxy.server_port,
                    password: proxy.password,
                    cipher: proxy.security,
                    tls: proxy.tls?.enabled || false,
                    'client-fingerprint': proxy.tls?.utls?.fingerprint,
                    sni: proxy.tls?.server_name || '',
                    network: proxy.transport?.type || 'tcp',
                    'ws-opts': proxy.transport?.type === 'ws' ? {
                        path: proxy.transport.path,
                        headers: proxy.transport.headers
                    } : undefined,
                    'reality-opts': proxy.tls?.reality?.enabled ? {
                        'public-key': proxy.tls.reality.public_key,
                        'short-id': proxy.tls.reality.short_id,
                    } : undefined,
                    'grpc-opts': proxy.transport?.type === 'grpc' ? {
                        'grpc-service-name': proxy.transport.service_name,
                    } : undefined,
                    tfo: proxy.tcp_fast_open,
                    'skip-cert-verify': !!proxy.tls?.insecure,
                    ...(proxy.alpn ? { alpn: proxy.alpn } : {}),
                    'flow': proxy.flow ?? undefined,
                    udp: getClashUdpValue(proxy),
                };
            case 'tuic':
                return {
                    name: proxy.tag,
                    type: proxy.type,
                    server: proxy.server,
                    port: proxy.server_port,
                    uuid: proxy.uuid,
                    password: proxy.password,
                    'congestion-controller': proxy.congestion_control,
                    'skip-cert-verify': !!proxy.tls?.insecure,
                    ...(proxy.disable_sni !== undefined ? { 'disable-sni': proxy.disable_sni } : {}),
                    ...(proxy.tls?.alpn ? { alpn: proxy.tls.alpn } : {}),
                    'sni': proxy.tls?.server_name,
                    'udp-relay-mode': proxy.udp_relay_mode || 'native',
                    ...(proxy.zero_rtt !== undefined ? { 'zero-rtt': proxy.zero_rtt } : {}),
                    ...(proxy.reduce_rtt !== undefined ? { 'reduce-rtt': proxy.reduce_rtt } : {}),
                    ...(proxy.fast_open !== undefined ? { 'fast-open': proxy.fast_open } : {}),
                };
            case 'anytls': {
                const idleSessionCheckInterval = proxy['idle-session-check-interval'] ?? proxy.idle_session_check_interval;
                const idleSessionTimeout = proxy['idle-session-timeout'] ?? proxy.idle_session_timeout;
                const minIdleSession = proxy['min-idle-session'] ?? proxy.min_idle_session;
                return {
                    name: proxy.tag,
                    type: 'anytls',
                    server: proxy.server,
                    port: proxy.server_port,
                    password: proxy.password,
                    udp: getClashUdpValue(proxy),
                    ...(proxy.tls?.utls?.fingerprint ? { 'client-fingerprint': proxy.tls.utls.fingerprint } : {}),
                    ...(proxy.tls?.server_name ? { sni: proxy.tls.server_name } : {}),
                    ...(proxy.tls?.insecure !== undefined ? { 'skip-cert-verify': !!proxy.tls.insecure } : {}),
                    ...(proxy.tls?.alpn ? { alpn: proxy.tls.alpn } : {}),
                    ...(idleSessionCheckInterval !== undefined ? { 'idle-session-check-interval': idleSessionCheckInterval } : {}),
                    ...(idleSessionTimeout !== undefined ? { 'idle-session-timeout': idleSessionTimeout } : {}),
                    ...(minIdleSession !== undefined ? { 'min-idle-session': minIdleSession } : {}),
                };
            }
            default:
                return proxy; // Return as-is if no specific conversion is defined
        }
    }

    addProxyToConfig(proxy) {
        this.config.proxies = this.config.proxies || [];
        return addProxyWithDedup(this.config.proxies, proxy, {
            getName: (item) => item?.name,
            setName: (item, name) => {
                if (item) item.name = name;
            },
            isSame: (a = {}, b = {}) => {
                const { name: _name, ...restOfProxy } = b;
                const { name: __name, ...restOfExisting } = a;
                return JSON.stringify(restOfProxy) === JSON.stringify(restOfExisting);
            }
        });
    }

    hasConfigGroup(name) {
        return this.hasProxyGroup(name);
    }

    addSelectorGroup(name, members, type = 'select', providers = []) {
        this.config['proxy-groups'] = this.config['proxy-groups'] || [];
        this.config['proxy-groups'].push({
            name, type, proxies: uniqueNames(members),
            ...(providers.length > 0 ? { use: providers } : {}),
            ...(type === 'url-test' ? { url: 'https://www.gstatic.com/generate_204', interval: this.autoSelectInterval, tolerance: 50, lazy: false } : {})
        });
    }

    applyChainToProxy(proxy, entryGroupName) {
        return { ...proxy, 'dialer-proxy': entryGroupName };
    }

    hasProxyGroup(name) {
        const target = normalizeGroupName(name);
        return (this.config['proxy-groups'] || []).some(group => group && normalizeGroupName(group.name) === target);
    }

    addOutboundGroups(outbounds) {
        outbounds.forEach(outbound => {
            if (outbound !== this.t('outboundNames.Node Select')) {
                const name = this.t(`outboundNames.${outbound}`);
                if (!this.hasProxyGroup(name)) {
                    let proxies = this.getBusinessGroupMembers();
                    // For rules that should default to DIRECT, move DIRECT to the front
                    if (DIRECT_DEFAULT_RULES.has(outbound)) {
                        proxies = ['DIRECT', ...proxies.filter(p => p !== 'DIRECT')];
                    }
                    const group = {
                        type: "select",
                        name,
                        proxies
                    };
                    this.config['proxy-groups'].push(group);
                }
            }
        });
    }

    addCustomRuleGroups() {
        if (Array.isArray(this.customRules)) {
            this.customRules.forEach(rule => {
                const name = this.t(`outboundNames.${rule.name}`);
                if (!this.hasProxyGroup(name)) {
                    const proxies = this.getBusinessGroupMembers();
                    const group = {
                        type: "select",
                        name,
                        proxies
                    };
                    this.config['proxy-groups'].push(group);
                }
            });
        }
    }

    addFallBackGroup() {
        const name = this.t('outboundNames.Fall Back');
        if (this.hasProxyGroup(name)) return;
        const proxies = this.getBusinessGroupMembers();
        const group = {
            type: "select",
            name,
            proxies
        };
        this.config['proxy-groups'].push(group);
    }

    addCountryGroups() {
        const proxies = this.getOriginalProxies();
        const countryGroups = groupProxiesByCountry(proxies, {
            getName: proxy => this.getProxyName(proxy)
        });

        // Provider mode leaves no inline proxies, but mihomo can filter provider
        // members per group (`use` + `filter`), so enumerate countries from the
        // names collected at fetch time and reference the providers instead.
        const providerNames = this.getAllProviderNames();
        if (providerNames.length > 0 && this.providerNodeNames.length > 0) {
            const providerCountryGroups = groupProxiesByCountry(this.providerNodeNames, {
                getName: name => name
            });
            Object.keys(providerCountryGroups).forEach(country => {
                if (!countryGroups[country]) {
                    countryGroups[country] = { ...providerCountryGroups[country], proxies: [] };
                }
            });
        }

        const existingNames = new Set((this.config['proxy-groups'] || []).map(g => normalizeGroupName(g?.name)).filter(Boolean));

        const countries = Object.keys(countryGroups).sort((a, b) => a.localeCompare(b));
        const countryGroupNames = [];

        countries.forEach(country => {
            const { emoji, name, aliases, proxies } = countryGroups[country];
            const groupName = this.reserveGroupName(`${emoji} ${name}`);
            const norm = normalizeGroupName(groupName);
            if (!existingNames.has(norm)) {
                const group = {
                    name: groupName,
                    type: this.includeAutoSelect ? 'url-test' : 'select',
                    proxies,
                    ...(this.includeAutoSelect ? { url: 'https://www.gstatic.com/generate_204', interval: this.autoSelectInterval, lazy: false } : {})
                };
                // Add 'use' field if we have proxy-providers, narrowed to this
                // country so provider members don't leak into every group
                if (providerNames.length > 0) {
                    group.use = providerNames;
                    const filter = buildCountryNameFilter({ emoji, aliases });
                    if (filter) {
                        group.filter = filter;
                    }
                }
                this.config['proxy-groups'].push(group);
                existingNames.add(norm);
            }
            countryGroupNames.push(groupName);
        });

        this.countryGroupNames = countryGroupNames;
    }

    /**
     * Reject invalid proxy groups before final output.
     * Why: empty groups make Clash reject the whole config, so we should fail fast
     * instead of masking the upstream merge/parsing problem.
     */
    validateProxyGroups() {
        (this.config['proxy-groups'] || []).forEach(group => {
            const requiresMembers = group?.type === 'url-test' || group?.type === 'fallback';
            if (!requiresMembers) {
                return;
            }

            const hasProxyRefs = Array.isArray(group.proxies) && group.proxies.length > 0;
            const hasProviderRefs = Array.isArray(group.use) && group.use.length > 0;
            if (hasProxyRefs || hasProviderRefs) {
                return;
            }

            const groupName = group?.name || '(unnamed group)';
            throw new InvalidConfigError(
                `Invalid proxy group "${groupName}": type "${group.type}" requires at least one proxy or provider reference`
            );
        });
    }

    // 生成规则
    generateRules() {
        return generateRules(this.selectedRules, this.customRules);
    }

    formatConfig() {
        if (this.formattedConfig !== undefined) return this.formattedConfig;
        const rules = this.generateRules();
        const useMrs = supportsMrsFormat(this.userAgent);
        const { site_rule_providers, ip_rule_providers } = generateClashRuleSets(this.selectedRules, this.customRules, useMrs);
        this.config['rule-providers'] = {
            ...site_rule_providers,
            ...ip_rule_providers
        };
        const ruleResults = emitClashRules(rules, this.t);

        // Add proxy-providers if we have any
        if (this.providerUrls.length > 0) {
            this.config['proxy-providers'] = {
                ...this.config['proxy-providers'],
                ...this.generateProxyProviders()
            };
        }

        this.config.rules = [
            ...ruleResults,
            `MATCH,${this.t('outboundNames.Fall Back')}`
        ];

        this.config = applyConfigOverrides(this.config, this.configOverrides, 'clash');
        validateConfigReferences(this.config, 'clash');
        sanitizeClashProxyGroups(this.config);
        this.validateProxyGroups();
        this.config['proxy-groups'] = this.orderGroups(this.config['proxy-groups'] || [], group => group.name);

        // Enable Clash UI (external controller/dashboard) when requested or when custom UI params are provided
        if (this.enableClashUI || this.externalController || this.externalUiDownloadUrl) {
            const defaultController = '0.0.0.0:9090';
            const defaultUiPath = './ui';
            const defaultUiName = 'zashboard';
            const defaultUiUrl = 'https://gh-proxy.com/https://github.com/Zephyruso/zashboard/archive/refs/heads/gh-pages.zip';
            const defaultSecret = '';

            const controller = this.externalController || this.config['external-controller'] || defaultController;
            const uiPath = this.config['external-ui'] || defaultUiPath;
            const uiName = this.config['external-ui-name'] || defaultUiName;
            const uiUrl = this.externalUiDownloadUrl || this.config['external-ui-url'] || defaultUiUrl;
            const secret = this.config['secret'] ?? defaultSecret;

            this.config['external-controller'] = controller;
            this.config['external-ui'] = uiPath;
            this.config['external-ui-name'] = uiName;
            this.config['external-ui-url'] = uiUrl;
            this.config['secret'] = secret;
        }

        this.formattedConfig = yaml.dump(this.config);
        return this.formattedConfig;
    }
}
