/**
* @typedef {Object} StatsOptions
* Used for testing to inject and extract methods.
* @property {function} [createRTCSample] - Method for parsing an RTCStatsReport
*/
/**
* Collects any WebRTC statistics for the given peer connection.
* @param {RTCPeerConnection} peerConnection - Target connection.
* @param {StatsOptions} options - List of custom options.
* @return {Promise<any>} Universally-formatted version of RTC stats.
*/
export function getRTCStats(peerConnection: RTCPeerConnection, options: StatsOptions): Promise<any>;
/**
* Generate WebRTC stats report with information about ICE candidates for the given peer connection.
* @param {RTCPeerConnection} peerConnection - Target connection.
* @return {Promise<{iceCandidateStats: any[]; selectedIceCandidatePairStats?: {localCandidate: any; remoteCandidate: any}}>} ICE candidate stats report.
*/
export function getRTCIceCandidateStatsReport(peerConnection: RTCPeerConnection): Promise<{
    iceCandidateStats: any[];
    selectedIceCandidatePairStats?: {
        localCandidate: any;
        remoteCandidate: any;
    };
}>;
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
