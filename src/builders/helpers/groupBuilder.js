const normalize = (value) => typeof value === 'string' ? value.trim() : value;

export function uniqueNames(names = []) {
    const seen = new Set();
    const result = [];
    names.forEach(name => {
        if (typeof name !== 'string') return;
        const normalized = normalize(name);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        result.push(normalized);
    });
    return result;
}

export function withDirectReject(options = [], { includeReject = true } = {}) {
    return uniqueNames([
        ...options,
        'DIRECT',
        ...(includeReject ? ['REJECT'] : [])
    ]);
}

export function buildNodeSelectMembers({ ordinaryGroupName, chainGroupName, includeReject = true }) {
    return withDirectReject([chainGroupName, ordinaryGroupName], { includeReject });
}

export function buildOrdinaryMembers({ autoGroupName, allNodesGroupName, sourceGroupNames = [], countryGroupNames = [] }) {
    return uniqueNames([autoGroupName, allNodesGroupName, ...sourceGroupNames, ...countryGroupNames]);
}

export function buildSelectorMembers({ translator, ordinaryGroupName, chainGroupName, sourceGroupNames = [], includeReject = true }) {
    if (!translator) {
        throw new Error('buildSelectorMembers requires a translator function');
    }
    return withDirectReject([
        translator('outboundNames.Node Select'),
        ordinaryGroupName,
        chainGroupName,
        ...sourceGroupNames
    ], { includeReject });
}
