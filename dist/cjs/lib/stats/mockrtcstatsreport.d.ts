export default MockRTCStatsReport;
/**
 * Create a MockRTCStatsReport wrapper around a Map of RTCStats objects. If RTCStatsReport is available
 *   natively, it will be inherited so that instanceof checks pass.
 * @constructor
 * @extends RTCStatsReport
 * @param {Map<string, RTCStats>} statsMap - A Map of RTCStats objects to wrap
 *   with a MockRTCStatsReport object.
 */
declare function MockRTCStatsReport(statsMap: Map<string, RTCStats>): MockRTCStatsReport;
declare class MockRTCStatsReport {
    /**
     * Create a MockRTCStatsReport wrapper around a Map of RTCStats objects. If RTCStatsReport is available
     *   natively, it will be inherited so that instanceof checks pass.
     * @constructor
     * @extends RTCStatsReport
     * @param {Map<string, RTCStats>} statsMap - A Map of RTCStats objects to wrap
     *   with a MockRTCStatsReport object.
     */
    constructor(statsMap: Map<string, RTCStats>);
    [Symbol.iterator]: () => MapIterator<[string, RTCStats]>;
}
declare namespace MockRTCStatsReport {
    /**
     * Convert an array of RTCStats objects into a mock RTCStatsReport object.
     * @param {Array<RTCStats>}
     * @return {MockRTCStatsReport}
     */
    function fromArray(array: any): MockRTCStatsReport;
    /**
     * Convert a legacy RTCStatsResponse object into a mock RTCStatsReport object.
     * @param {RTCStatsResponse} statsResponse - An RTCStatsResponse object returned by the
     *   legacy getStats(callback) method in Chrome.
     * @return {MockRTCStatsReport} A mock RTCStatsReport object.
     */
    function fromRTCStatsResponse(statsResponse: RTCStatsResponse): MockRTCStatsReport;
}
