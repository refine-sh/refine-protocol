import { lstat, readFile } from "node:fs/promises";
import * as net from "node:net";
import { dirname, isAbsolute, join } from "node:path";


export type ProtocolObject = Record<string, unknown>;

export interface TransportSession {
  readonly serverEpoch: string;
  readonly runResumed: boolean;
  send(message: ProtocolObject): Promise<void>;
  events(): AsyncIterable<ProtocolObject>;
  close(): Promise<void>;
}

export interface TransportSessionOptions {
  readonly initialCommandSequence?: number;
  readonly initialEventSequence?: number;
}

export class ProtocolError extends Error {}

export class HandshakeRejected extends Error {
  readonly rejection: ProtocolObject;

  constructor(rejection: ProtocolObject) {
    super(`Refine rejected the connection: ${String(rejection.reason)}`);
    this.rejection = rejection;
  }
}

const MAX_FRAME_BYTES = 8_388_608;
const MAX_SOURCE_BYTES = 1_048_576;
const MAX_SAFE_INTEGER = 9_007_199_254_740_991;
const UINT16_MAX = 65_535;
const UINT32_MAX = 4_294_967_295;
const ACTION_KEYS = new Set([
  "tab", "escape", "return", "space", "delete",
  "leftArrow", "rightArrow", "upArrow", "downArrow",
  "leftShift", "rightShift", "leftOption", "rightOption",
  "leftControl", "rightControl",
]);
const ACTIONS = ["apply", "dismiss", "explain", "report"] as const;
const ACTION_REJECTION_REASONS = [
  "stale", "disconnected", "engineUnavailable", "validationUnavailable",
  "readOnly", "nonAtomic", "mutationUnavailable", "mutationIndeterminate",
  "applyNotProven", "reportingUnavailable", "unsupportedAction",
] as const;
const EXPLANATION_UNAVAILABLE_REASONS = [
  "disconnected", "engineUnavailable", "validationUnavailable", "readOnly",
  "nonAtomic", "mutationUnavailable", "mutationIndeterminate",
  "applyNotProven", "reportingUnavailable",
] as const;

function record(value: unknown, context: string): ProtocolObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolError(`${context} must be an object`);
  }
  return value as ProtocolObject;
}

function has(value: ProtocolObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function required(value: ProtocolObject, key: string, context: string): unknown {
  if (!has(value, key)) throw new ProtocolError(`${context}.${key} is required`);
  return value[key];
}

function forbid(value: ProtocolObject, keys: readonly string[], context: string): void {
  const present = keys.find((key) => has(value, key));
  if (present !== undefined) throw new ProtocolError(`${context}.${present} is forbidden for this union branch`);
}

function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new ProtocolError(`${context} must be an array`);
  return value;
}

function string(value: unknown, context: string, nonempty = false): string {
  if (typeof value !== "string" || (nonempty && value.length === 0)) {
    throw new ProtocolError(`${context} must be ${nonempty ? "a nonempty" : "a"} string`);
  }
  return value;
}

function boolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") throw new ProtocolError(`${context} must be boolean`);
  return value;
}

function enumeration(value: unknown, allowed: readonly string[], context: string): string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new ProtocolError(`${context} has an unknown enum value`);
  }
  return value;
}

function validatePortableValue(value: unknown, context = "JSON value", seen = new Set<object>()): void {
  if (value === null) throw new ProtocolError(`${context} must not be null`);
  if (typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ProtocolError(`${context} must be a nonnegative interoperable integer`);
    }
    return;
  }
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const unit = value.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new ProtocolError(`${context} has an unpaired high surrogate`);
        index += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        throw new ProtocolError(`${context} has an unpaired low surrogate`);
      }
    }
    return;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new ProtocolError(`${context} is outside the portable JSON data model`);
  }
  if (seen.has(value)) throw new ProtocolError(`${context} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => validatePortableValue(item, `${context}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      validatePortableValue(key, `${context} member name`, seen);
      validatePortableValue(item, `${context}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function visibleIdentifier(value: unknown, context: string): string {
  if (typeof value !== "string" || !/^[!-~]{1,128}$/.test(value)) {
    throw new ProtocolError(`${context} must be a 1-128 byte visible ASCII identifier`);
  }
  return value;
}

function uniqueEnumArray(value: unknown, allowed: readonly string[], context: string): string[] {
  const result = array(value, context).map((item, index) => enumeration(item, allowed, `${context}[${index}]`));
  if (new Set(result).size !== result.length) throw new ProtocolError(`${context} contains a duplicate`);
  return result;
}

function capabilitySet(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new ProtocolError(`${context} must be an array of at most 64 identifiers`);
  }
  const capabilities = value.map((item, index) => visibleIdentifier(item, `${context}[${index}]`));
  if (new Set(capabilities).size !== capabilities.length) {
    throw new ProtocolError(`${context} contains a duplicate`);
  }
  return capabilities;
}

function exactProtocol(value: unknown, context: string): void {
  const protocol = record(value, context);
  if (protocol.major !== 1 || protocol.minor !== 0) {
    throw new ProtocolError(`${context} is not exact Protocol 1.0`);
  }
}

function integer(value: unknown, minimum: number, maximum: number, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ProtocolError(`${context} must be an integer in ${minimum}...${maximum}`);
  }
  return value as number;
}

function validateRange(value: unknown, context: string, nonempty = false): { location: number; length: number } {
  const range = record(value, context);
  const location = integer(required(range, "location", context), 0, MAX_SAFE_INTEGER, `${context}.location`);
  const length = integer(required(range, "length", context), nonempty ? 1 : 0, MAX_SAFE_INTEGER, `${context}.length`);
  if (location + length > MAX_SAFE_INTEGER) {
    throw new ProtocolError(`${context} location + length exceeds the interoperable range`);
  }
  return { location, length };
}

function anyProtocol(value: unknown, context: string): void {
  const protocol = record(value, context);
  integer(protocol.major, 0, UINT16_MAX, `${context}.major`);
  integer(protocol.minor, 0, UINT16_MAX, `${context}.minor`);
}

function validateSnapshot(value: unknown, context: string): void {
  const snapshot = record(value, context);
  visibleIdentifier(required(snapshot, "revision", context), `${context}.revision`);
  const sources = array(required(snapshot, "sources", context), `${context}.sources`);
  if (sources.length < 1 || sources.length > 2) throw new ProtocolError(`${context}.sources must contain one or two sources`);
  const sourceIds: string[] = [];
  sources.forEach((item, index) => {
    const sourceContext = `${context}.sources[${index}]`;
    const source = record(item, sourceContext);
    sourceIds.push(visibleIdentifier(required(source, "sourceId", sourceContext), `${sourceContext}.sourceId`));
    const text = string(required(source, "text", sourceContext), `${sourceContext}.text`);
    if (Buffer.byteLength(text, "utf8") > MAX_SOURCE_BYTES) throw new ProtocolError(`${sourceContext}.text exceeds maxSourceBytes`);
    enumeration(required(source, "sourceSyntax", sourceContext), ["plainText", "markdownDocument", "markdownDocumentHardLineBreaks", "latexDocument"], `${sourceContext}.sourceSyntax`);
  });
  if (new Set(sourceIds).size !== sourceIds.length) throw new ProtocolError(`${context}.sources contains a duplicate sourceId`);
}

function validateAttention(value: unknown, context: string): void {
  const attention = record(value, context);
  visibleIdentifier(required(attention, "sourceId", context), `${context}.sourceId`);
  if (has(attention, "caretOffset")) integer(attention.caretOffset, 0, MAX_SAFE_INTEGER, `${context}.caretOffset`);
  const ranges = array(required(attention, "visibleRanges", context), `${context}.visibleRanges`);
  let priorEnd: number | undefined;
  ranges.forEach((item, index) => {
    const range = validateRange(item, `${context}.visibleRanges[${index}]`, true);
    if (priorEnd !== undefined && range.location < priorEnd) {
      throw new ProtocolError(`${context}.visibleRanges must be ordered and nonoverlapping`);
    }
    priorEnd = range.location + range.length;
  });
}

function validateCheckIntent(value: unknown, context: string): void {
  const intent = record(value, context);
  if (has(intent, "forcedLanguageTag")) visibleIdentifier(intent.forcedLanguageTag, `${context}.forcedLanguageTag`);
  if (has(intent, "sourceIds") && has(intent, "selection")) {
    throw new ProtocolError(`${context} must not contain both sourceIds and selection`);
  }
  if (has(intent, "sourceIds")) {
    const sourceIds = array(intent.sourceIds, `${context}.sourceIds`).map(
      (item, index) => visibleIdentifier(item, `${context}.sourceIds[${index}]`),
    );
    if (sourceIds.length < 1 || sourceIds.length > 2 || new Set(sourceIds).size !== sourceIds.length) {
      throw new ProtocolError(`${context}.sourceIds must contain one or two unique identifiers`);
    }
  }
  if (has(intent, "selection")) {
    const selection = record(intent.selection, `${context}.selection`);
    visibleIdentifier(required(selection, "sourceId", `${context}.selection`), `${context}.selection.sourceId`);
    validateRange(required(selection, "range", `${context}.selection`), `${context}.selection.range`, true);
  }
}

function validateSuggestionReference(value: unknown, context: string): void {
  const suggestion = record(value, context);
  visibleIdentifier(required(suggestion, "id", context), `${context}.id`);
  visibleIdentifier(required(suggestion, "documentRevision", context), `${context}.documentRevision`);
}

function validateApplyOutcome(value: unknown, context: string): void {
  const outcome = record(value, context);
  const status = enumeration(required(outcome, "status", context), ["applied", "rejected", "unsupported", "unavailable", "indeterminate"], `${context}.status`);
  if (status === "applied") {
    forbid(outcome, ["reason"], context);
    validateSnapshot(required(outcome, "snapshot", context), `${context}.snapshot`);
  } else if (status === "rejected") {
    enumeration(required(outcome, "reason", context), ["staleRevision", "textMismatch"], `${context}.reason`);
    validateSnapshot(required(outcome, "snapshot", context), `${context}.snapshot`);
  } else if (status === "unsupported") {
    enumeration(required(outcome, "reason", context), ["readOnly", "nonAtomic"], `${context}.reason`);
    if (has(outcome, "snapshot")) validateSnapshot(outcome.snapshot, `${context}.snapshot`);
  } else {
    forbid(outcome, ["reason"], context);
    if (has(outcome, "snapshot")) validateSnapshot(outcome.snapshot, `${context}.snapshot`);
  }
}

function validateApplyRequest(value: unknown, context: string): void {
  const request = record(value, context);
  visibleIdentifier(required(request, "expectedRevision", context), `${context}.expectedRevision`);
  visibleIdentifier(required(request, "sourceId", context), `${context}.sourceId`);
  const edits = array(required(request, "edits", context), `${context}.edits`);
  if (edits.length === 0) throw new ProtocolError(`${context}.edits must not be empty`);
  let priorLocation: number | undefined;
  edits.forEach((item, index) => {
    const editContext = `${context}.edits[${index}]`;
    const edit = record(item, editContext);
    const range = validateRange(required(edit, "range", editContext), `${editContext}.range`);
    const expectedText = string(required(edit, "expectedText", editContext), `${editContext}.expectedText`);
    const replacement = string(required(edit, "replacement", editContext), `${editContext}.replacement`);
    if (expectedText === replacement) throw new ProtocolError(`${editContext} is a no-op`);
    if (priorLocation !== undefined && (range.location >= priorLocation || range.location + range.length > priorLocation)) {
      throw new ProtocolError(`${context}.edits must descend without ties or overlap`);
    }
    priorLocation = range.location;
  });
}

function validateAppearance(value: unknown, context: string): void {
  const appearance = record(value, context);
  const highlight = record(required(appearance, "highlight", context), `${context}.highlight`);
  enumeration(required(highlight, "style", `${context}.highlight`), ["underline", "dashedUnderline", "highlight"], `${context}.highlight.style`);
  for (const name of ["grammarColor", "fluencyColor"] as const) {
    const color = string(required(highlight, name, `${context}.highlight`), `${context}.highlight.${name}`);
    if (!/^#[0-9A-F]{6}$/.test(color)) throw new ProtocolError(`${context}.highlight.${name} is not an sRGB color`);
  }
  const diff = record(required(appearance, "diff", context), `${context}.diff`);
  for (const name of ["additionColor", "deletionColor"] as const) {
    const color = string(required(diff, name, `${context}.diff`), `${context}.diff.${name}`);
    if (!/^#[0-9A-F]{6}$/.test(color)) throw new ProtocolError(`${context}.diff.${name} is not an sRGB color`);
  }
  boolean(required(diff, "showHiddenWhitespace", `${context}.diff`), `${context}.diff.showHiddenWhitespace`);
}

function validateInteraction(value: unknown, context: string): void {
  const interaction = record(value, context);
  boolean(required(interaction, "automaticChecksEnabled", context), `${context}.automaticChecksEnabled`);
  const quickApply = record(required(interaction, "quickApply", context), `${context}.quickApply`);
  boolean(required(quickApply, "enabled", `${context}.quickApply`), `${context}.quickApply.enabled`);
  enumeration(required(quickApply, "applyKey", `${context}.quickApply`), [...ACTION_KEYS], `${context}.quickApply.applyKey`);
  enumeration(required(quickApply, "dismissKey", `${context}.quickApply`), [...ACTION_KEYS], `${context}.quickApply.dismissKey`);
  enumeration(required(quickApply, "activationStyle", `${context}.quickApply`), ["highlightChanges", "showTipAndHighlight"], `${context}.quickApply.activationStyle`);
}

function validateAttribution(value: unknown, context: string, explanation = false): void {
  const attribution = record(value, context);
  string(required(attribution, "languageDisplayName", context), `${context}.languageDisplayName`, true);
  enumeration(required(attribution, "textDirection", context), ["ltr", "rtl"], `${context}.textDirection`);
  const modelKey = explanation ? "modelDisplayName" : "checkModelDisplayName";
  string(required(attribution, modelKey, context), `${context}.${modelKey}`, true);
}

function validateSuggestion(value: unknown, context: string): void {
  const suggestion = record(value, context);
  visibleIdentifier(required(suggestion, "id", context), `${context}.id`);
  visibleIdentifier(required(suggestion, "sourceId", context), `${context}.sourceId`);
  enumeration(required(suggestion, "kind", context), ["grammar", "fluency", "mixed"], `${context}.kind`);
  validateAttribution(required(suggestion, "attribution", context), `${context}.attribution`);
  validateRange(required(suggestion, "activationRange", context), `${context}.activationRange`);
  array(required(suggestion, "highlightRanges", context), `${context}.highlightRanges`).forEach(
    (item, index) => validateRange(item, `${context}.highlightRanges[${index}]`),
  );
  array(required(suggestion, "diff", context), `${context}.diff`).forEach((item, index) => {
    const run = record(item, `${context}.diff[${index}]`);
    enumeration(required(run, "kind", `${context}.diff[${index}]`), ["unchanged", "delete", "insert"], `${context}.diff[${index}].kind`);
    string(required(run, "text", `${context}.diff[${index}]`), `${context}.diff[${index}].text`);
  });
  uniqueEnumArray(required(suggestion, "availableActions", context), ACTIONS, `${context}.availableActions`);
}

function validatePresentation(value: unknown, context: string): void {
  const content = record(value, context);
  visibleIdentifier(required(content, "documentRevision", context), `${context}.documentRevision`);
  const status = enumeration(required(content, "status", context), ["pending", "checking", "complete", "unavailable", "closed"], `${context}.status`);
  const suggestions = array(required(content, "suggestions", context), `${context}.suggestions`);
  suggestions.forEach((item, index) => validateSuggestion(item, `${context}.suggestions[${index}]`));
  validateAppearance(required(content, "appearance", context), `${context}.appearance`);
  validateInteraction(required(content, "interaction", context), `${context}.interaction`);
  if (has(content, "progress")) {
    const progress = record(content.progress, `${context}.progress`);
    const completed = integer(required(progress, "completedUnitCount", `${context}.progress`), 0, MAX_SAFE_INTEGER, `${context}.progress.completedUnitCount`);
    const total = integer(required(progress, "totalUnitCount", `${context}.progress`), 0, MAX_SAFE_INTEGER, `${context}.progress.totalUnitCount`);
    if (completed > total) throw new ProtocolError(`${context}.progress completedUnitCount exceeds totalUnitCount`);
  }
  if (status === "pending") {
    if (suggestions.length !== 0) throw new ProtocolError(`${context}.suggestions must be empty while pending`);
    forbid(content, ["coverage", "unavailableReason", "progress"], context);
  } else if (status === "checking") {
    forbid(content, ["coverage", "unavailableReason"], context);
  } else if (status === "complete") {
    enumeration(required(content, "coverage", context), ["full", "partial"], `${context}.coverage`);
    forbid(content, ["unavailableReason", "progress"], context);
  } else if (status === "unavailable") {
    if (suggestions.length !== 0) throw new ProtocolError(`${context}.suggestions must be empty while unavailable`);
    enumeration(required(content, "unavailableReason", context), [
      "disconnected", "checkFailed", "engineUnavailable", "invalidDocument",
      "unsupportedSource", "resourceLimit", "writingCheckEntitlementRequired",
    ], `${context}.unavailableReason`);
    forbid(content, ["coverage", "progress"], context);
  } else {
    if (suggestions.length !== 0) throw new ProtocolError(`${context}.suggestions must be empty while closed`);
    forbid(content, ["coverage", "unavailableReason", "progress"], context);
  }
}

function validateExplanationUpdate(value: unknown, context: string): void {
  const update = record(value, context);
  const status = enumeration(required(update, "status", context), ["started", "streaming", "completed", "stale", "unavailable"], `${context}.status`);
  if (status === "started") {
    validateAttribution(required(update, "attribution", context), `${context}.attribution`, true);
  } else if (status === "streaming" || status === "completed") {
    string(required(update, "text", context), `${context}.text`);
  } else if (status === "unavailable") {
    enumeration(required(update, "reason", context), EXPLANATION_UNAVAILABLE_REASONS, `${context}.reason`);
  }
}

function validateHello(value: ProtocolObject): void {
  validatePortableValue(value, "hello");
  if (value.type !== "hello") throw new ProtocolError("hello.type must be hello");
  exactProtocol(value.protocol, "hello.protocol");
  const client = record(value.client, "hello.client");
  visibleIdentifier(client.id, "hello.client.id");
  visibleIdentifier(client.version, "hello.client.version");
  visibleIdentifier(client.host, "hello.client.host");
  if (value.frontend !== undefined) {
    const frontend = record(value.frontend, "hello.frontend");
    visibleIdentifier(frontend.id, "hello.frontend.id");
  }
  const hostCapabilities = record(value.hostCapabilities, "hello.hostCapabilities");
  if (!Array.isArray(hostCapabilities.interceptableSuggestionActionKeys)) {
    throw new ProtocolError("hello.hostCapabilities.interceptableSuggestionActionKeys must be an array");
  }
  const keys = hostCapabilities.interceptableSuggestionActionKeys;
  if (new Set(keys).size !== keys.length || keys.some((key) => !ACTION_KEYS.has(String(key)))) {
    throw new ProtocolError("hello host action keys contain an unknown or duplicate value");
  }
  visibleIdentifier(value.runId, "hello.runId");
  if (typeof value.launchToken !== "string" || !/^[0-9A-F]{64}$/.test(value.launchToken)) {
    throw new ProtocolError("hello.launchToken is invalid");
  }
  capabilitySet(value.capabilities, "hello.capabilities");
}

function validateRejection(value: ProtocolObject): ProtocolObject {
  validatePortableValue(value, "rejected");
  if (value.type !== "rejected") throw new ProtocolError("handshake response is not rejected");
  exactProtocol(value.protocol, "rejected.protocol");
  const reason = value.reason;
  const recovery = value.recovery;
  const validPair =
    (reason === "incompatibleProtocol" && recovery === "none") ||
    (reason === "invalidClient" && recovery === "none") ||
    (reason === "runUnavailable" && (recovery === "newRun" || recovery === "retry")) ||
    (reason === "serverBusy" && recovery === "retry") ||
    (reason === "engineUnavailable" && recovery === "retry");
  if (!validPair) throw new ProtocolError("rejected reason/recovery pair is invalid");
  if (reason === "incompatibleProtocol") {
    anyProtocol(value.receivedProtocol, "rejected.receivedProtocol");
  } else if (has(value, "receivedProtocol")) {
    throw new ProtocolError("receivedProtocol is only valid for incompatibleProtocol");
  }
  return value;
}

function validateFault(value: ProtocolObject): boolean {
  const code = value.code;
  const fatal = value.fatal;
  const valid =
    (code === "invalidSequence" && fatal === true) ||
    (["malformedMessage", "resourceLimit", "internalError"].includes(String(code)) && typeof fatal === "boolean") ||
    (["invalidDocument", "unsupportedSource", "engineUnavailable"].includes(String(code)) && fatal === false);
  if (!valid) throw new ProtocolError("fault code/fatal pair is invalid");
  return fatal as boolean;
}

function validateWelcome(value: ProtocolObject): { serverEpoch: string; runResumed: boolean; capabilities: string[] } {
  validatePortableValue(value, "welcome");
  if (value.type !== "welcome") throw new ProtocolError("handshake response is not welcome");
  exactProtocol(required(value, "protocol", "welcome"), "welcome.protocol");
  const serverEpoch = visibleIdentifier(required(value, "serverEpoch", "welcome"), "welcome.serverEpoch");
  const runResumed = boolean(required(value, "runResumed", "welcome"), "welcome.runResumed");
  const limits = record(required(value, "limits", "welcome"), "welcome.limits");
  if (
    required(limits, "maxFrameBytes", "welcome.limits") !== MAX_FRAME_BYTES
    || required(limits, "maxSources", "welcome.limits") !== 2
    || required(limits, "maxSourceBytes", "welcome.limits") !== MAX_SOURCE_BYTES
  ) {
    throw new ProtocolError("welcome limits do not equal Protocol 1.0 constants");
  }
  const capabilities = capabilitySet(required(value, "capabilities", "welcome"), "welcome.capabilities");
  return { serverEpoch, runResumed, capabilities };
}

function validateEventPayload(value: ProtocolObject, context: string): boolean {
  const type = string(required(value, "type", context), `${context}.type`);
  switch (type) {
    case "documentAccepted":
      visibleIdentifier(required(value, "revision", context), `${context}.revision`);
      return false;
    case "resyncRequired":
      enumeration(required(value, "reason", context), ["documentNotOpen", "conflictingRevision", "reusedRevision", "invalidDocument"], `${context}.reason`);
      return false;
    case "presentationContentReplaced":
      visibleIdentifier(required(value, "checkId", context), `${context}.checkId`);
      validatePresentation(required(value, "content", context), `${context}.content`);
      return false;
    case "applyRequested":
      visibleIdentifier(required(value, "actionId", context), `${context}.actionId`);
      visibleIdentifier(required(value, "transactionId", context), `${context}.transactionId`);
      validateApplyRequest(required(value, "request", context), `${context}.request`);
      return false;
    case "explanationReplaced":
      visibleIdentifier(required(value, "actionId", context), `${context}.actionId`);
      validateExplanationUpdate(required(value, "update", context), `${context}.update`);
      return false;
    case "actionCompleted":
      visibleIdentifier(required(value, "actionId", context), `${context}.actionId`);
      return false;
    case "actionRejected":
      visibleIdentifier(required(value, "actionId", context), `${context}.actionId`);
      enumeration(required(value, "reason", context), ACTION_REJECTION_REASONS, `${context}.reason`);
      return false;
    case "fault":
      return validateFault(value);
    default:
      throw new ProtocolError(`${context}.type is an unknown event discriminator`);
  }
}

function validateEventEnvelope(
  value: ProtocolObject,
  expectedSequence: number,
  serverEpoch: string,
): { value: ProtocolObject; fatal: boolean } {
  if (value.type !== "event") throw new ProtocolError("server frame must be an event envelope");
  const sequence = integer(value.sequence, 1, UINT32_MAX, "event.sequence");
  if (sequence !== expectedSequence) {
    throw new ProtocolError(`event.sequence must be ${expectedSequence}, received ${sequence}`);
  }
  const epoch = visibleIdentifier(value.epoch, "event.epoch");
  if (epoch !== serverEpoch) throw new ProtocolError("event epoch differs from welcome epoch");
  if (value.causeCommandId !== undefined) {
    visibleIdentifier(value.causeCommandId, "event.causeCommandId");
  }
  const event = record(value.event, "event.event");
  return { value, fatal: validateEventPayload(event, "event.event") };
}

function validateCommandPayload(value: ProtocolObject, context: string): void {
  const type = string(required(value, "type", context), `${context}.type`);
  switch (type) {
    case "openDocument":
    case "replaceDocument":
      validateSnapshot(required(value, "snapshot", context), `${context}.snapshot`);
      return;
    case "updateAttention":
      visibleIdentifier(required(value, "revision", context), `${context}.revision`);
      validateAttention(required(value, "attention", context), `${context}.attention`);
      return;
    case "requestCheck":
      visibleIdentifier(required(value, "revision", context), `${context}.revision`);
      if (has(value, "intent")) validateCheckIntent(value.intent, `${context}.intent`);
      return;
    case "performAction":
      visibleIdentifier(required(value, "actionId", context), `${context}.actionId`);
      enumeration(required(value, "kind", context), ACTIONS, `${context}.kind`);
      validateSuggestionReference(required(value, "suggestion", context), `${context}.suggestion`);
      return;
    case "completeApply":
      visibleIdentifier(required(value, "transactionId", context), `${context}.transactionId`);
      validateApplyOutcome(required(value, "outcome", context), `${context}.outcome`);
      return;
    case "closeDocument":
      return;
    default:
      throw new ProtocolError(`${context}.type is an unknown command discriminator`);
  }
}

function validateCommandEnvelope(value: ProtocolObject): number {
  validatePortableValue(value, "command");
  if (value.type !== "command") throw new ProtocolError("outbound message must be a command envelope");
  const sequence = integer(value.sequence, 1, UINT32_MAX, "command.sequence");
  visibleIdentifier(value.id, "command.id");
  const command = record(value.command, "command.command");
  validateCommandPayload(command, "command.command");
  return sequence;
}

class StrictJsonParser {
  readonly text: string;
  index = 0;

  constructor(text: string) {
    this.text = text;
  }

  parse(): unknown {
    const value = this.value();
    this.whitespace();
    if (this.index !== this.text.length) {
      throw new ProtocolError("JSON has trailing data");
    }
    return value;
  }

  private whitespace(): void {
    while (" \t\r\n".includes(this.text[this.index] ?? "") && this.index < this.text.length) {
      this.index += 1;
    }
  }

  private value(): unknown {
    this.whitespace();
    const character = this.text[this.index];
    if (character === "{") return this.object();
    if (character === "[") return this.array();
    if (character === '"') return this.string();
    if (this.text.startsWith("true", this.index)) {
      this.index += 4;
      return true;
    }
    if (this.text.startsWith("false", this.index)) {
      this.index += 5;
      return false;
    }
    if (this.text.startsWith("null", this.index)) {
      throw new ProtocolError("JSON null is outside the portable profile");
    }
    return this.integer();
  }

  private object(): ProtocolObject {
    const result: ProtocolObject = {};
    const keys = new Set<string>();
    this.index += 1;
    this.whitespace();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return result;
    }
    while (true) {
      this.whitespace();
      if (this.text[this.index] !== '"') throw new ProtocolError("object key must be a string");
      const key = this.string();
      if (keys.has(key)) throw new ProtocolError(`duplicate object member ${JSON.stringify(key)}`);
      keys.add(key);
      this.whitespace();
      if (this.text[this.index] !== ":") throw new ProtocolError("object key must be followed by a colon");
      this.index += 1;
      result[key] = this.value();
      this.whitespace();
      if (this.text[this.index] === "}") {
        this.index += 1;
        return result;
      }
      if (this.text[this.index] !== ",") throw new ProtocolError("object members must be comma separated");
      this.index += 1;
    }
  }

  private array(): unknown[] {
    const result: unknown[] = [];
    this.index += 1;
    this.whitespace();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return result;
    }
    while (true) {
      result.push(this.value());
      this.whitespace();
      if (this.text[this.index] === "]") {
        this.index += 1;
        return result;
      }
      if (this.text[this.index] !== ",") throw new ProtocolError("array values must be comma separated");
      this.index += 1;
    }
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      if (!escaped && character === '"') {
        this.index += 1;
        let decoded: unknown;
        try {
          decoded = JSON.parse(this.text.slice(start, this.index));
        } catch {
          throw new ProtocolError("invalid JSON string");
        }
        if (typeof decoded !== "string") throw new ProtocolError("invalid JSON string");
        for (let position = 0; position < decoded.length; position += 1) {
          const unit = decoded.charCodeAt(position);
          if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = decoded.charCodeAt(position + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) throw new ProtocolError("unpaired high surrogate");
            position += 1;
          } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            throw new ProtocolError("unpaired low surrogate");
          }
        }
        return decoded;
      }
      if (!escaped && character.charCodeAt(0) < 0x20) throw new ProtocolError("unescaped control character");
      if (!escaped && character === "\\") {
        escaped = true;
      } else {
        escaped = false;
      }
      this.index += 1;
    }
    throw new ProtocolError("unterminated JSON string");
  }

  private integer(): number {
    const remainder = this.text.slice(this.index);
    const match = /^-?(?:0|[1-9][0-9]*)/.exec(remainder);
    if (match === null) throw new ProtocolError("invalid JSON value");
    const following = remainder[match[0].length];
    if (following === "." || following === "e" || following === "E") {
      throw new ProtocolError("numeric fields require integer lexical form");
    }
    if (match[0].startsWith("-")) throw new ProtocolError("negative numeric tokens are invalid");
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isSafeInteger(value)) throw new ProtocolError("integer is outside the interoperable range");
    return value;
  }
}

export function strictJson(text: string): unknown {
  return new StrictJsonParser(text).parse();
}

function encodeFrame(value: ProtocolObject): Buffer {
  validatePortableValue(value, "outbound frame");
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length === 0 || payload.length > MAX_FRAME_BYTES) {
    throw new ProtocolError("outbound frame is outside maxFrameBytes");
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

class FrameReader {
  private readonly socket: net.Socket;
  private buffer = Buffer.alloc(0);
  private queue: ProtocolObject[] = [];
  private waiters: Array<{ resolve: (value: ProtocolObject) => void; reject: (error: Error) => void }> = [];
  private closeWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private failure: Error | undefined;
  private closed = false;
  private terminalCloseExpected = false;

  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.onClose());
  }

  next(): Promise<ProtocolObject> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.closed) return Promise.reject(new ProtocolError("socket closed"));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  expectTerminalClose(): Promise<void> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.queue.length > 0) {
      const error = new ProtocolError("server sent a frame after a terminal event");
      this.fail(error);
      return Promise.reject(error);
    }
    this.terminalCloseExpected = true;
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => this.closeWaiters.push({ resolve, reject }));
  }

  private receive(chunk: Buffer): void {
    try {
      if (this.terminalCloseExpected) {
        throw new ProtocolError("server sent bytes after a terminal event");
      }
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32BE(0);
        if (length === 0 || length > MAX_FRAME_BYTES) throw new ProtocolError("invalid inbound frame length");
        if (this.buffer.length < 4 + length) return;
        const payload = this.buffer.subarray(4, 4 + length);
        this.buffer = this.buffer.subarray(4 + length);
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(payload);
        const message = record(strictJson(decoded), "frame payload");
        const waiter = this.waiters.shift();
        if (waiter === undefined) this.queue.push(message);
        else waiter.resolve(message);
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new ProtocolError(String(error)));
    }
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    this.buffer = Buffer.alloc(0);
    this.queue = [];
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    for (const waiter of this.closeWaiters.splice(0)) waiter.reject(error);
    this.socket.destroy();
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.failure !== undefined) return;
    if (this.buffer.length > 0) {
      this.fail(new ProtocolError("socket closed during a frame"));
      return;
    }
    const error = new ProtocolError("socket closed");
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    for (const waiter of this.closeWaiters.splice(0)) waiter.resolve();
  }
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, context: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new ProtocolError(`${context} timed out`)), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function connectSocket(path: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function validateLocalPath(
  path: string,
  kind: "directory" | "file" | "socket",
  expectedMode: number,
): Promise<void> {
  const information = await lstat(path).catch((error: unknown) => {
    throw new ProtocolError(`${kind} path ${path} is unavailable`, { cause: error });
  });
  const correctKind =
    (kind === "directory" && information.isDirectory()) ||
    (kind === "file" && information.isFile()) ||
    (kind === "socket" && information.isSocket());
  if (!correctKind) throw new ProtocolError(`${kind} path has the wrong file type`);
  if ((information.mode & 0o7777) !== expectedMode) {
    throw new ProtocolError(`${kind} path must have mode 0${expectedMode.toString(8)}`);
  }
  if (typeof process.getuid === "function" && information.uid !== process.getuid()) {
    throw new ProtocolError(`${kind} path is not owned by the current user`);
  }
}

function write(socket: net.Socket, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function connectTransportSession(
  descriptorPath: string,
  hello: ProtocolObject,
  knownCapabilities: readonly string[] = [],
  options: TransportSessionOptions = {},
): Promise<TransportSession> {
  const descriptorDirectory = dirname(descriptorPath);
  await validateLocalPath(descriptorDirectory, "directory", 0o700);
  await validateLocalPath(join(descriptorDirectory, "owner.lock"), "file", 0o600);
  await validateLocalPath(descriptorPath, "file", 0o600);
  const descriptor = record(strictJson(await readFile(descriptorPath, "utf8")), "endpoint descriptor");
  if (descriptor.version !== 1 || descriptor.protocolMajor !== 1 || descriptor.protocolMinor !== 0) {
    throw new ProtocolError("endpoint descriptor is not schema 1 with exact Protocol 1.0");
  }
  const socketPath = descriptor.socketPath;
  const launchToken = descriptor.launchToken;
  const descriptorEpoch = visibleIdentifier(descriptor.serverEpoch, "descriptor.serverEpoch");
  integer(descriptor.pid, 1, 2_147_483_647, "descriptor.pid");
  if (typeof socketPath !== "string" || socketPath.length === 0 || !isAbsolute(socketPath)) {
    throw new ProtocolError("descriptor.socketPath must be an absolute path");
  }
  if (typeof launchToken !== "string" || !/^[0-9A-F]{64}$/.test(launchToken)) throw new ProtocolError("descriptor.launchToken is invalid");
  await validateLocalPath(dirname(socketPath), "directory", 0o700);
  await validateLocalPath(socketPath, "socket", 0o600);

  const authenticatedHello: ProtocolObject = { ...hello, launchToken };
  validateHello(authenticatedHello);
  const offered = authenticatedHello.capabilities as string[];
  const socket = await withTimeout(connectSocket(socketPath), 5_000, "socket connection");
  const reader = new FrameReader(socket);
  let serverEpoch: string;
  let runResumed: boolean;
  try {
    await write(socket, encodeFrame(authenticatedHello));
    const response = await withTimeout(reader.next(), 5_000, "handshake");
    if (response.type === "rejected") {
      throw new HandshakeRejected(validateRejection(response));
    }
    if (response.type !== "welcome") {
      throw new ProtocolError("handshake response is neither welcome nor rejected");
    }
    const welcome = validateWelcome(response);
    serverEpoch = welcome.serverEpoch;
    if (serverEpoch !== descriptorEpoch) throw new ProtocolError("welcome epoch differs from descriptor epoch");
    runResumed = welcome.runResumed;
    const activated = welcome.capabilities;
    const known = new Set(knownCapabilities);
    if (activated.some((item) => !offered.includes(item) || !known.has(item))) {
      throw new ProtocolError("server activated an unoffered or unrecognized capability");
    }
  } catch (error) {
    socket.destroy();
    throw error;
  }

  let closed = false;
  let expectedCommandSequence = integer(
    options.initialCommandSequence ?? 1,
    1,
    UINT32_MAX,
    "initialCommandSequence",
  );
  let expectedEventSequence = integer(
    options.initialEventSequence ?? 1,
    1,
    UINT32_MAX,
    "initialEventSequence",
  );
  return {
    serverEpoch,
    runResumed,
    async send(message: ProtocolObject): Promise<void> {
      if (closed) throw new ProtocolError("session is closed");
      const sequence = validateCommandEnvelope(message);
      if (sequence !== expectedCommandSequence) {
        throw new ProtocolError(`command.sequence must be ${expectedCommandSequence}, received ${sequence}`);
      }
      await write(socket, encodeFrame(message));
      if (sequence === UINT32_MAX) {
        closed = true;
        socket.end();
      } else {
        expectedCommandSequence += 1;
      }
    },
    async *events(): AsyncIterable<ProtocolObject> {
      try {
        while (!closed) {
          const raw = await reader.next();
          const event = validateEventEnvelope(raw, expectedEventSequence, serverEpoch);
          const terminal = event.fatal || expectedEventSequence === UINT32_MAX;
          if (!terminal) expectedEventSequence += 1;
          yield event.value;
          if (terminal) {
            await withTimeout(reader.expectTerminalClose(), 5_000, "terminal server close");
            closed = true;
            return;
          }
        }
      } catch (error) {
        closed = true;
        socket.destroy();
        throw error;
      }
    },
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise((resolve) => {
        socket.end(resolve);
      });
    },
  };
}
