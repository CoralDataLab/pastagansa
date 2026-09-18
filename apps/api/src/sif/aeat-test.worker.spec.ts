import { SifAeatSubmissionStatus as Status } from "@prisma/client";
import { predecessorHasDefinitiveAeatResponse } from "./aeat-test.worker";

describe("AEAT test submission ordering", () => {
  it("sends after a definitive line-level rejection in the local chain", () => {
    expect(predecessorHasDefinitiveAeatResponse({
      status: Status.REJECTED,
      recordStatus: "Incorrecto",
    })).toBe(true);
  });

  it("waits when delivery or rejection is not a definitive line-level response", () => {
    expect(predecessorHasDefinitiveAeatResponse(null)).toBe(false);
    for (const status of [Status.PENDING, Status.SENDING, Status.RETRY, Status.FAILED, Status.UNKNOWN]) {
      expect(predecessorHasDefinitiveAeatResponse({ status, recordStatus: null })).toBe(false);
    }
    expect(predecessorHasDefinitiveAeatResponse({ status: Status.REJECTED, recordStatus: null })).toBe(false);
  });

  it("continues after accepted records", () => {
    expect(predecessorHasDefinitiveAeatResponse({
      status: Status.ACCEPTED,
      recordStatus: "Correcto",
    })).toBe(true);
    expect(predecessorHasDefinitiveAeatResponse({
      status: Status.ACCEPTED_WITH_ERRORS,
      recordStatus: "AceptadoConErrores",
    })).toBe(true);
  });
});
