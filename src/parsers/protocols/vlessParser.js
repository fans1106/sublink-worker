import { parseServerInfo, parseUrlParams, createTlsConfig, createTransportConfig, parseBool } from '../../utils.js';

export function parseVless(url) {
    const { addressPart, params, name } = parseUrlParams(url);
    const [uuid, serverInfo] = addressPart.split('@');
    const { host, port } = parseServerInfo(serverInfo);

    const tls = createTlsConfig(params);
    if (tls.reality) {
        tls.utls = {
            enabled: true,
            fingerprint: 'chrome'
        };
    }
    const transport = params.type !== 'tcp' ? createTransportConfig(params) : undefined;

    // `udp` is a Clash-only flag; ClashConfigBuilder reads it, SingboxConfigBuilder strips it.
    const udp = params.udp !== undefined ? parseBool(params.udp) : undefined;
    const supportX25519Mlkem768 = parseBool(
        params['support-x25519mlkem768'] ?? params.support_x25519mlkem768
    );
    if (tls.reality && supportX25519Mlkem768 !== undefined) {
        tls.reality.support_x25519mlkem768 = supportX25519Mlkem768;
    }

    return {
        type: 'vless',
        tag: name,
        server: host,
        server_port: port,
        uuid: decodeURIComponent(uuid),
        tcp_fast_open: false,
        tls,
        transport,
        flow: params.flow ?? undefined,
        ...(udp !== undefined ? { udp } : {})
    };
}
