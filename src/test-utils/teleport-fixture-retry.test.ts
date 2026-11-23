import { expect, test } from "bun:test";
import { CloudReadinessError } from "./cloud-readiness-retry";
import {
  deleteCloudFixture,
  initiateFixtureTeleport,
} from "./teleport-fixture-retry";

const noWait = async () => {};

test("capability preflight retries are bounded and stop on success", async () => {
  let attempts = 0;
  const initiate = async () => {
    if (++attempts < 3)
      throw new CloudReadinessError(409, "TELEPORT_NOT_SUPPORTED");
    return { id: "teleport-1" };
  };
  expect(await initiateFixtureTeleport(initiate, noWait)).toEqual({
    id: "teleport-1",
  });
  expect(attempts).toBe(3);
  attempts = 0;
  const error = new CloudReadinessError(409, "TELEPORT_NOT_SUPPORTED");
  await expect(
    initiateFixtureTeleport(async () => {
      attempts++;
      throw error;
    }, noWait),
  ).rejects.toBe(error);
  expect(attempts).toBe(3);
});

test("never retries ambiguous initiation failures or other rejections", async () => {
  for (const error of [
    new CloudReadinessError(409, "TELEPORT_SOURCE_NOT_ACTIVE"),
    new CloudReadinessError(503),
    new CloudReadinessError(400, "TELEPORT_NOT_SUPPORTED"),
    new Error("request timed out"),
  ]) {
    let attempts = 0;
    await expect(
      initiateFixtureTeleport(async () => {
        attempts++;
        throw error;
      }, noWait),
    ).rejects.toBe(error);
    expect(attempts).toBe(1);
  }
});

test("cleanup accepts missing fixtures and retries transient server failures", async () => {
  await deleteCloudFixture(async () => {
    throw new CloudReadinessError(404);
  }, noWait);
  let attempts = 0;
  await deleteCloudFixture(async () => {
    if (++attempts < 3) throw { status: 503 };
  }, noWait);
  expect(attempts).toBe(3);
});

test("cleanup exposes exhausted and permanent failures to the caller", async () => {
  for (const status of [401, 403, 409, 500, 503]) {
    let attempts = 0;
    const error = new CloudReadinessError(status);
    await expect(
      deleteCloudFixture(async () => {
        attempts++;
        throw error;
      }, noWait),
    ).rejects.toBe(error);
    expect(attempts).toBe(status >= 500 ? 3 : 1);
  }
});
