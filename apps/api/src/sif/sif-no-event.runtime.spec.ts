import { operationalTimeSinceSummary } from "./sif-no-event.runtime";

describe("NO VERI*FACTU summary timing", () => {
  it("counts active time across restarts and resets after a summary", () => {
    const at = (hour: number) => new Date(Date.UTC(2026, 8, 22, hour));
    expect(operationalTimeSinceSummary([
      { eventType: "01", generatedAt: at(0) },
      { eventType: "02", generatedAt: at(2) },
      { eventType: "01", generatedAt: at(4) },
    ], at(8))).toBe(6 * 3_600_000);
    expect(operationalTimeSinceSummary([
      { eventType: "01", generatedAt: at(0) },
      { eventType: "10", generatedAt: at(5) },
      { eventType: "02", generatedAt: at(7) },
    ], at(9))).toBe(2 * 3_600_000);
  });
});
