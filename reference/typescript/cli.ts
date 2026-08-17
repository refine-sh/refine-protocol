#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import {
  connectTransportSession,
  HandshakeRejected,
  ProtocolError,
  type ProtocolObject,
  type TransportSession,
} from "./transport-session.ts";


function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || value === undefined) throw new Error(`missing ${name}`);
  return value;
}

function record(value: unknown, context: string): ProtocolObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as ProtocolObject;
}

function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value;
}

function substitute(value: unknown, launchToken: string, serverEpoch: string): unknown {
  if (value === "${launchToken}") return launchToken;
  if (value === "${serverEpoch}") return serverEpoch;
  if (Array.isArray(value)) return value.map((item) => substitute(item, launchToken, serverEpoch));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substitute(item, launchToken, serverEpoch)]),
    );
  }
  return value;
}

function stepMessage(step: ProtocolObject, messages: ProtocolObject): ProtocolObject {
  if (step.message !== undefined) return record(step.message, "scenario step.message");
  if (typeof step.messageRef !== "string") throw new Error("scenario step has no message or messageRef");
  return record(messages[step.messageRef], `scenario message ${step.messageRef}`);
}

function assertEqual(actual: unknown, expected: unknown, context: string): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${context} differs from the state vector`);
  }
}

async function expectProtocolError(
  events: AsyncIterator<ProtocolObject>,
  context: string,
): Promise<void> {
  try {
    await events.next();
  } catch (error) {
    if (error instanceof ProtocolError) return;
    throw error;
  }
  throw new Error(`${context} did not produce ProtocolError`);
}

async function runConnection(
  descriptorPath: string,
  connectionValue: unknown,
  messages: ProtocolObject,
): Promise<void> {
  const connection = record(connectionValue, "scenario connection");
  const steps = array(connection.steps, "scenario connection.steps").map(
    (value, index) => record(value, `scenario step ${index}`),
  );
  if (steps.length < 2) throw new Error("socket scenario connection has no handshake");
  const helloStep = steps[0];
  const responseStep = steps[1];
  if (helloStep.direction !== "client" || responseStep.direction !== "server") {
    throw new Error("socket scenario handshake directions are invalid");
  }
  const hello = stepMessage(helloStep, messages);
  const expectedResponse = stepMessage(responseStep, messages);
  const expectedCapabilities = Array.isArray(expectedResponse.capabilities)
    ? expectedResponse.capabilities.filter((item): item is string => typeof item === "string")
    : [];
  const sequenceStarts = connection.sequenceStarts === undefined
    ? {}
    : record(connection.sequenceStarts, "scenario connection.sequenceStarts");

  let session: TransportSession;
  try {
    session = await connectTransportSession(descriptorPath, hello, expectedCapabilities, {
      initialCommandSequence: sequenceStarts.client as number | undefined,
      initialEventSequence: sequenceStarts.server as number | undefined,
    });
  } catch (error) {
    if (responseStep.invalid !== undefined) {
      if (error instanceof ProtocolError && !(error instanceof HandshakeRejected)) return;
      throw new Error("invalid handshake response did not produce ProtocolError", { cause: error });
    }
    if (expectedResponse.type !== "rejected") throw error;
    if (!(error instanceof HandshakeRejected)) {
      throw new Error("expected a typed HandshakeRejected error", { cause: error });
    }
    assertEqual(error.rejection, expectedResponse, "handshake rejection");
    return;
  }
  if (responseStep.invalid !== undefined) {
    await session.close();
    throw new Error("invalid handshake response was accepted");
  }
  if (expectedResponse.type === "rejected") {
    await session.close();
    throw new Error("server accepted a connection that should have been rejected");
  }
  if (expectedResponse.type !== "welcome") {
    await session.close();
    throw new Error("scenario handshake response is not welcome or rejected");
  }
  assertEqual(session.runResumed, expectedResponse.runResumed, "welcome.runResumed");
  const expectedEpoch = substitute(expectedResponse.serverEpoch, "unused", session.serverEpoch);
  assertEqual(session.serverEpoch, expectedEpoch, "welcome.serverEpoch");

  const events = session.events()[Symbol.asyncIterator]();
  for (const step of steps.slice(2)) {
    if (step.close === true) {
      if (step.direction === "client") {
        await session.close();
      } else if (step.direction === "server") {
        const result = await events.next();
        if (!result.done) throw new Error("server sent an event after its terminal close step");
      } else {
        throw new Error("scenario close step has an invalid direction");
      }
      continue;
    }
    if (step.rawFrameHex !== undefined) {
      if (step.direction !== "server") throw new Error("reference client only consumes raw server frames");
      await expectProtocolError(events, "invalid server frame");
      continue;
    }
    const message = substitute(
      stepMessage(step, messages),
      "unused",
      session.serverEpoch,
    ) as ProtocolObject;
    if (step.invalid !== undefined) {
      if (step.direction !== "server") throw new Error("invalid fixture is not server-directed");
      await expectProtocolError(events, String(step.invalid));
      continue;
    }
    if (step.direction === "client") {
      await session.send(message);
    } else if (step.direction === "server") {
      const result = await events.next();
      if (result.done) throw new Error("server closed before the expected event");
      assertEqual(result.value, message, "server event");
    } else {
      throw new Error("scenario message step has an invalid direction");
    }
  }
  await session.close();
}

async function main(): Promise<void> {
  const descriptor = argument("--descriptor");
  const scenario = argument("--scenario");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scenario)) throw new Error("invalid scenario identifier");
  const vectorUrl = new URL(`../../vectors/state/${scenario}.json`, import.meta.url);
  const vector = record(JSON.parse(await readFile(vectorUrl, "utf8")), "state vector");
  if (vector.id !== scenario || vector.socketRunnable !== true) {
    throw new Error(`scenario ${scenario} is not socket-runnable`);
  }
  const messages = vector.messages === undefined ? {} : record(vector.messages, "state vector messages");
  for (const connection of array(vector.connections, "state vector connections")) {
    await runConnection(descriptor, connection, messages);
  }
  process.stdout.write(JSON.stringify({ status: "ok", scenario }) + "\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message + "\n");
  process.exitCode = 1;
});
