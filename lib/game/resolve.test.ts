import { describe, expect, it } from "vitest";
import { resolveRound, type ResolvableBoat } from "./resolve";

const boat = (
  id: string,
  seated: string[],
  capacity = 3,
): ResolvableBoat => ({ id, symbolId: `sym-${id}`, capacity, seatedPlayerIds: seated });

describe("resolveRound", () => {
  it("drowns everyone who never claimed a seat", () => {
    const alive = ["a", "b", "c", "d"];
    const result = resolveRound(alive, [boat("b1", ["a", "b", "c"])]);

    expect(result.survivorIds).toEqual(["a", "b", "c"]);
    expect(result.eliminatedIds).toEqual(["d"]);
    expect(result.boats[0]).toMatchObject({ filled: 3, sank: false });
  });

  it("spares an underfilled boat when lenient, sinks it when strict", () => {
    const alive = ["a", "b", "c"];
    const half = [boat("b1", ["a", "b"])];

    expect(resolveRound(alive, half, "lenient").survivorIds).toEqual(["a", "b"]);

    const strict = resolveRound(alive, half, "strict");
    expect(strict.survivorIds).toEqual([]);
    expect(strict.eliminatedIds).toEqual(["a", "b", "c"]);
    expect(strict.boats[0]).toMatchObject({ sank: true, eliminatedIds: ["a", "b"] });
  });

  it("ignores seats held by players who are no longer alive", () => {
    // "b" was kicked mid-round; their seat must not survive them, and it must
    // not count toward filling the boat under a strict policy.
    const result = resolveRound(["a", "c"], [boat("b1", ["a", "b", "c"])], "strict");
    expect(result.boats[0]).toMatchObject({ filled: 2, sank: true });
    expect(result.survivorIds).toEqual([]);
  });

  it("eliminates everyone when no boat was ever formed", () => {
    const result = resolveRound(["a", "b"], []);
    expect(result.survivorIds).toEqual([]);
    expect(result.eliminatedIds).toEqual(["a", "b"]);
  });

  it("is idempotent — re-running on its own survivors changes nothing", () => {
    // The lazy-resolution path can fire more than once; it must be safe.
    const alive = ["a", "b", "c", "d"];
    const boats = [boat("b1", ["a", "b", "c"])];
    const first = resolveRound(alive, boats);
    const second = resolveRound(first.survivorIds, boats);
    expect(second.survivorIds).toEqual(first.survivorIds);
    expect(second.eliminatedIds).toEqual([]);
  });
});
