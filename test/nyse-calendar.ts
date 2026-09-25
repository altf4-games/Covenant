import { expect } from "chai";
import { isRegularSessionOpen, lastRegularClose } from "../scripts/lib/nyse-calendar.js";

// Every date below is checked against NYSE's own 2026-2027 table at
// nyse.com/markets/hours-calendars (read 2026-09-25) and real US daylight-
// saving dates (EDT until 2026-11-01, EST after; EDT again from 2027-03-14).
const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();

describe("NYSE calendar (Feature 1's session source)", function () {
  it("open during a regular summer session, closed before and after (EDT, UTC-4)", function () {
    expect(isRegularSessionOpen(at("2026-09-24T13:29:00Z"))).to.equal(false); // 9:29 ET
    expect(isRegularSessionOpen(at("2026-09-24T13:30:00Z"))).to.equal(true); // 9:30 ET
    expect(isRegularSessionOpen(at("2026-09-24T19:59:00Z"))).to.equal(true); // 3:59 ET
    expect(isRegularSessionOpen(at("2026-09-24T20:00:00Z"))).to.equal(false); // 4:00 ET
  });

  it("the moment this was checked live - Friday 2026-09-25 07:21 UTC - is closed, last close Thursday 20:00 UTC", function () {
    const now = at("2026-09-25T07:21:49Z");
    expect(isRegularSessionOpen(now)).to.equal(false);
    expect(iso(lastRegularClose(now))).to.equal("2026-09-24T20:00:00.000Z");
  });

  it("during a session, the last close is the previous trading day's", function () {
    expect(iso(lastRegularClose(at("2026-09-25T15:00:00Z")))).to.equal("2026-09-24T20:00:00.000Z");
  });

  it("a weekend reaches back to Friday's close", function () {
    expect(isRegularSessionOpen(at("2026-09-26T16:00:00Z"))).to.equal(false);
    expect(iso(lastRegularClose(at("2026-09-27T23:00:00Z")))).to.equal("2026-09-25T20:00:00.000Z");
  });

  it("a full-closure holiday is closed: Labor Day 2026 (Mon Sep 7) reaches back to Fri Sep 4", function () {
    expect(isRegularSessionOpen(at("2026-09-07T15:00:00Z"))).to.equal(false);
    expect(iso(lastRegularClose(at("2026-09-07T15:00:00Z")))).to.equal("2026-09-04T20:00:00.000Z");
  });

  it("an early close ends at 1:00 p.m. ET: Fri Nov 27 2026 (EST, UTC-5)", function () {
    expect(isRegularSessionOpen(at("2026-11-27T17:59:00Z"))).to.equal(true); // 12:59 ET
    expect(isRegularSessionOpen(at("2026-11-27T18:00:00Z"))).to.equal(false); // 1:00 ET
    expect(iso(lastRegularClose(at("2026-11-27T19:00:00Z")))).to.equal("2026-11-27T18:00:00.000Z");
    // Thanksgiving itself (Thu Nov 26) is a full closure, so during the
    // early-close Friday session the last close is Wednesday's.
    expect(iso(lastRegularClose(at("2026-11-27T15:00:00Z")))).to.equal("2026-11-25T21:00:00.000Z");
  });

  it("follows daylight saving without hand-written offsets", function () {
    // After DST ends on 2026-11-01, the open is 14:30 UTC, not 13:30.
    expect(isRegularSessionOpen(at("2026-11-02T13:45:00Z"))).to.equal(false);
    expect(isRegularSessionOpen(at("2026-11-02T14:30:00Z"))).to.equal(true);
    // After DST starts on 2027-03-14, the open is 13:30 UTC again.
    expect(isRegularSessionOpen(at("2027-03-15T13:30:00Z"))).to.equal(true);
  });

  it("refuses a year it has no holiday data for, instead of guessing", function () {
    expect(() => isRegularSessionOpen(at("2028-03-01T15:00:00Z"))).to.throw(/no holiday data for 2028/);
  });
});
