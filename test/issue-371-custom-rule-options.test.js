import { describe, it, expect } from 'vitest';
import { SingboxConfigBuilder } from '../src/builders/SingboxConfigBuilder.js';
import { ClashConfigBuilder } from '../src/builders/ClashConfigBuilder.js';
import { SurgeConfigBuilder } from '../src/builders/SurgeConfigBuilder.js';

describe('Issue #371 - custom rule groups keep source choices without raw nodes or country groups', () => {
    const inputString = [
        'ss://YWVzLTI1Ni1nY206dGVzdA==@us1.example.com:8388#US-Node-1',
        'ss://YWVzLTI1Ni1nY206dGVzdA==@uk1.example.com:8388#UK-Node-1'
    ].join('\n');

    const customRules = [
        { name: 'Custom-Rule', site_rules: ['google'], ip_rules: [], domain_suffix: [], domain_keyword: [] }
    ];

    const expectedSingboxCountryMembers = ['🚀 节点选择', '🌐 普通代理', '📥 手动节点', 'DIRECT'];
    const expectedSingboxFlatMembers = expectedSingboxCountryMembers;
    const expectedCountryMembers = [...expectedSingboxCountryMembers, 'REJECT'];
    const expectedFlatMembers = expectedCountryMembers;

    const expectCompleteOptionsWithoutCountries = (members, expectedMembers) => {
        expect(members).toEqual(expectedMembers);
        expect(members.some(member =>
            member.includes('🇺🇸') || member.includes('🇬🇧') || member.includes('United States') || member.includes('United Kingdom')
        )).toBe(false);
        expect(members).not.toContain('US-Node-1');
        expect(members).not.toContain('UK-Node-1');
    };

    it('Singbox custom rule includes source choices when groupByCountry is enabled', async () => {
        const builder = new SingboxConfigBuilder(
            inputString,
            'minimal',
            customRules,
            null,
            'zh-CN',
            '',
            true,
            false,
            null,
            null,
            '1.12',
            true
        );

        await builder.build();

        const customRule = builder.config.outbounds.find(outbound => outbound?.tag === 'Custom-Rule');
        expectCompleteOptionsWithoutCountries(customRule.outbounds, expectedSingboxCountryMembers);
    });

    it('Singbox custom rule includes source choices when groupByCountry is disabled', async () => {
        const builder = new SingboxConfigBuilder(
            inputString,
            'minimal',
            customRules,
            null,
            'zh-CN',
            '',
            false,
            false,
            null,
            null,
            '1.12',
            true
        );

        await builder.build();

        const customRule = builder.config.outbounds.find(outbound => outbound?.tag === 'Custom-Rule');
        expectCompleteOptionsWithoutCountries(customRule.outbounds, expectedSingboxFlatMembers);
    });

    it('Clash custom rule includes source choices when groupByCountry is enabled', async () => {
        const builder = new ClashConfigBuilder(
            inputString,
            'minimal',
            customRules,
            null,
            'zh-CN',
            '',
            true,
            false,
            null,
            null,
            true
        );

        await builder.build();

        const customRule = builder.config['proxy-groups'].find(group => group?.name === 'Custom-Rule');
        expectCompleteOptionsWithoutCountries(customRule.proxies, expectedCountryMembers);
    });

    it('Clash custom rule includes source choices when groupByCountry is disabled', async () => {
        const builder = new ClashConfigBuilder(
            inputString,
            'minimal',
            customRules,
            null,
            'zh-CN',
            '',
            false,
            false,
            null,
            null,
            true
        );

        await builder.build();

        const customRule = builder.config['proxy-groups'].find(group => group?.name === 'Custom-Rule');
        expectCompleteOptionsWithoutCountries(customRule.proxies, expectedFlatMembers);
    });

    it('Surge custom rule includes source choices when groupByCountry is enabled', async () => {
        const builder = new SurgeConfigBuilder(
            inputString,
            'minimal',
            customRules,
            null,
            'zh-CN',
            '',
            true,
            true
        );

        await builder.build();

        const customRule = builder.config['proxy-groups'].find(group =>
            typeof group === 'string' && group.startsWith('Custom-Rule = select')
        );
        expect(customRule).toBeDefined();

        const members = customRule
            .split(',')
            .slice(1)
            .map(member => member.trim());
        expectCompleteOptionsWithoutCountries(members, expectedCountryMembers);
    });

    it('Surge custom rule includes source choices when groupByCountry is disabled', async () => {
        const builder = new SurgeConfigBuilder(
            inputString,
            'minimal',
            customRules,
            null,
            'zh-CN',
            '',
            false,
            true
        );

        await builder.build();

        const customRule = builder.config['proxy-groups'].find(group =>
            typeof group === 'string' && group.startsWith('Custom-Rule = select')
        );
        expect(customRule).toBeDefined();

        const members = customRule
            .split(',')
            .slice(1)
            .map(member => member.trim());
        expectCompleteOptionsWithoutCountries(members, expectedFlatMembers);
    });
});
