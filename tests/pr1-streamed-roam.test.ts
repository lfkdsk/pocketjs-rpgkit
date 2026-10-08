import { describe, expect, test } from "bun:test";
import { StreamedRoam } from "../tools/pr1-streamed-roam.ts";

describe("PR1 streamed roam workload", () => {
  test("crosses the real placed world and churns every cache layer", () => {
    const roam = new StreamedRoam();
    for (let frame = 0; frame < 1_400; frame++) roam.step();
    const stats = roam.stats();

    expect(stats.visitedMaps).toBe(12);
    expect(stats.mapChanges).toBeGreaterThanOrEqual(40);
    expect(stats.handoffTicks).toBe(stats.mapChanges * 8);
    expect(stats.tablePublishes).toBeGreaterThan(0);
    expect(stats.tableEvictions).toBeGreaterThan(0);
    expect(stats.runtimeBuilds).toBe(stats.mapChanges);
    expect(stats.runtimeEvictions).toBe(stats.mapChanges);

    // The real driver's keep sets, repository and compiled tables remain
    // bounded while the walk repeatedly revisits all twelve placed maps.
    expect(stats.maxMaps).toBeLessThan(12);
    expect(stats.maxTables).toBeLessThanOrEqual(3);
    expect(stats.maxRuntime).toBe(1);
    expect(stats.driver.failures).toEqual({});
    expect(stats.driver.maps).toBeLessThanOrEqual(stats.driver.parsedKeep.length);
    expect(stats.driver.tables).toBeLessThanOrEqual(stats.driver.compiledKeep.length);
    expect(stats.driver.repoCached).toBeLessThanOrEqual(stats.driver.parsedKeep.length);
  });
});
