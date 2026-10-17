import { captureAttemptContext, runProducer } from './reviewer-producer-run.mjs';

export const HOST_HANDOFF_LIMIT = 4096;
export const QUALIFICATION_STEP = 'Synthetic reviewer handoff qualification';
export const SEAL_STEP = 'Attest host-only reviewer handoff';
export const REVIEW_WORKFLOW = 'knitli/.github/.github/workflows/claude-pr-reviewer.yml';
const fail = code => { throw new Error(`Reviewer host handoff refused: ${code}`); };
const exact = (value, keys) => value && !Array.isArray(value) && typeof value === 'object'
  && Object.keys(value).sort().join('|') === [...keys].sort().join('|');

function pinnedAttempt(value) {
  const attempt = captureAttemptContext(value);
  if (attempt.workflowRef !== `${REVIEW_WORKFLOW}@${attempt.workflowSha}`) fail('workflow_pin');
  return attempt;
}

/** Trusted host API. Fixture capture/driver ports remain host-owned, never artifact inputs. */
export async function captureQualificationPublication(options) {
  if (!options || options.onPublished !== undefined) fail('callback_override');
  const attempt = pinnedAttempt(options.attemptContext);
  let captured;
  const envelope = await runProducer({ ...options, attemptContext: attempt, onPublished: handoff => {
    if (captured) fail('duplicate_callback');
    captured = handoff;
  } });
  if (envelope.status !== 'completed' || !captured) fail('producer_incomplete');
  // Only this host writes step outputs; child stdout and bundle fields are never parsed as outputs.
  const outputs = Object.freeze({ attemptJson: JSON.stringify(captured.attempt), envelopeSha256: captured.envelopeSha256 });
  return { envelope, outputs };
}

/** Fresh sealing-job API: producerOutputs are platform needs outputs, not downloaded JSON. */
export function sealQualificationHandoff({ producerOutputs, platformContext }) {
  const sealer = pinnedAttempt(platformContext);
  if (!exact(producerOutputs, ['attemptJson', 'envelopeSha256'])
    || typeof producerOutputs.attemptJson !== 'string' || Buffer.byteLength(producerOutputs.attemptJson) > HOST_HANDOFF_LIMIT
    || typeof producerOutputs.envelopeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(producerOutputs.envelopeSha256)) fail('outputs');
  let value;
  try { value = JSON.parse(producerOutputs.attemptJson); } catch { fail('outputs'); }
  const attempt = pinnedAttempt(value);
  if (attempt.checkRunId === sealer.checkRunId
    || Object.keys(attempt).some(key => key !== 'checkRunId' && attempt[key] !== sealer[key])) fail('sealer_identity');
  const bytes = Buffer.from(`${JSON.stringify({ schema: 'knitli-reviewer-host-handoff:v1', purpose: 'synthetic-qualification',
    attempt, sealCheckRunId: sealer.checkRunId, envelopeSha256: producerOutputs.envelopeSha256 })}\n`);
  if (bytes.length > HOST_HANDOFF_LIMIT) fail('handoff_limit');
  return bytes;
}

/** Parse only after cryptographic verification; this function does not authenticate bytes. */
export function readQualificationHandoff(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > HOST_HANDOFF_LIMIT) fail('handoff_limit');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('handoff'); }
  if (!exact(value, ['schema', 'purpose', 'attempt', 'sealCheckRunId', 'envelopeSha256'])
    || value.schema !== 'knitli-reviewer-host-handoff:v1' || value.purpose !== 'synthetic-qualification'
    || typeof value.sealCheckRunId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value.sealCheckRunId)
    || typeof value.envelopeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.envelopeSha256)) fail('handoff');
  const attempt = pinnedAttempt(value.attempt);
  if (attempt.checkRunId === value.sealCheckRunId) fail('sealer_identity');
  return Object.freeze({ ...value, attempt });
}
