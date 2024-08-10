declare namespace _exports {
    export { StatsOptions, RTCSample };
}
declare namespace _exports {
    export { getRTCStats };
    export { getRTCIceCandidateStatsReport };
}
export = _exports;
/**
 * Used for testing to inject and extract methods.
 */
type StatsOptions = {
    /**
     * - Method for parsing an RTCStatsReport
     */
    /**
     * - Method for parsing an RTCStatsReport
     */
    createRTCSample?: Function | undefined;
};
/**
 * - A sample containing relevant WebRTC stats information.
 */
type RTCSample = {
    timestamp?: number | undefined;
    /**
     * - MimeType name of the codec being used by the outbound audio stream
     */
    /**
     * - MimeType name of the codec being used by the outbound audio stream
     */
    codecName?: string | undefined;
    /**
     * - Round trip time
     */
    /**
     * - Round trip time
     */
    rtt?: number | undefined;
    jitter?: number | undefined;
    packetsSent?: number | undefined;
    packetsLost?: number | undefined;
    packetsReceived?: number | undefined;
    bytesReceived?: number | undefined;
    bytesSent?: number | undefined;
    localAddress?: number | undefined;
    remoteAddress?: number | undefined;
};
/**
* @typedef {Object} StatsOptions
* Used for testing to inject and extract methods.
* @property {function} [createRTCSample] - Method for parsing an RTCStatsReport
*/
/**
* Collects any WebRTC statistics for the given {@link PeerConnection}
* @param {PeerConnection} peerConnection - Target connection.
* @param {StatsOptions} options - List of custom options.
* @return {Promise<RTCSample>} Universally-formatted version of RTC stats.
*/
declare function getRTCStats(peerConnection: PeerConnection, options: StatsOptions): Promise<RTCSample>;
/**
* Generate WebRTC stats report containing relevant information about ICE candidates for the given {@link PeerConnection}
* @param {PeerConnection} peerConnection - Target connection.
* @return {Promise<RTCIceCandidateStatsReport>} RTCIceCandidateStatsReport object
*/
declare function getRTCIceCandidateStatsReport(peerConnection: PeerConnection): Promise<RTCIceCandidateStatsReport>;
