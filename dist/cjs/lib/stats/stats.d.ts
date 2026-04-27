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
export function getRTCStats(peerConnection: PeerConnection, options: StatsOptions): Promise<RTCSample>;
/**
* Generate WebRTC stats report containing relevant information about ICE candidates for the given {@link PeerConnection}
* @param {PeerConnection} peerConnection - Target connection.
* @return {Promise<RTCIceCandidateStatsReport>} RTCIceCandidateStatsReport object
*/
export function getRTCIceCandidateStatsReport(peerConnection: PeerConnection): Promise<RTCIceCandidateStatsReport>;
/**
 * Used for testing to inject and extract methods.
 */
export type StatsOptions = {
    /**
     * - Method for parsing an RTCStatsReport
     */
    createRTCSample?: Function | undefined;
};
/**
 * - A sample containing relevant WebRTC stats information.
 */
export type RTCSample = {
    timestamp?: number | undefined;
    /**
     * - MimeType name of the codec being used by the outbound audio stream
     */
    codecName?: string | undefined;
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
