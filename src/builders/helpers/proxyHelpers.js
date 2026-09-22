function defaultGetName(item) {
    return item?.name || item?.tag || '';
}

function defaultSetName(item, name) {
    if (item) {
        if ('name' in item) {
            item.name = name;
        } else if ('tag' in item) {
            item.tag = name;
        }
    }
}

function defaultIsSame(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

export function addProxyWithDedup(collection, proxy, { getName = defaultGetName, setName = defaultSetName, isSame = defaultIsSame } = {}) {
    if (!proxy) return null;
    if (!Array.isArray(collection)) {
        throw new Error('addProxyWithDedup expects the target collection to be an array');
    }

    let candidate = proxy;
    const targetName = getName(candidate) || '';
    const identical = collection.find(item => isSame(item, candidate));
    if (identical) {
        return identical;
    }

    const usedNames = new Set(collection.map(item => getName(item) || ''));
    if (usedNames.has(targetName) && typeof setName === 'function' && targetName) {
        let suffix = 2;
        while (usedNames.has(`${targetName} ${suffix}`)) suffix += 1;
        const updated = setName(candidate, `${targetName} ${suffix}`);
        if (typeof updated !== 'undefined') {
            candidate = updated;
        }
    }

    collection.push(candidate);
    return candidate;
}
