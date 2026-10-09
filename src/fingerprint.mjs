import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { analyzeGlobalOutputs } from '../vendor/modeltrace/fingerprint-core.js';
import { validateNumbers } from '../vendor/modeltrace/probe-output.mjs';

const VENDOR_ROOT = new URL('../vendor/modeltrace/', import.meta.url);
const COMMIT = 'd4131b30243dfa05e70180b5eedde742103f1d73';
const REPOSITORY = 'https://github.com/xqy2006/ModelTrace';
const BANK_SHA256 = 'e514c76928ea38d23bc0f14d3935f23c97b1efb6d96b18a19bdc88ad2d830536';
const SCORER_SHA256 = '83fa5bd611e18f8339122582335123c8ea168ed242298bb31f4e363abeeb6e4a';
const RECOMMENDED_SAMPLES = 3;

const LIMITATIONS = Object.freeze([
  'score 是当前候选库内的相似度权重，不是模型身份证明，也不是降智分数。',
  '未在 Magpie / Codex 当前调用路径或同任务长上下文中独立校准；上游交叉验证准确率不等于这里的准确率。',
  '未收录模型仍会归入现有候选；系统提示词、推理强度、上下文、语言和采样设置可能改变输出分布。',
  '重复采样可能相关，不能将多次结果按独立事件相乘；新测试会话不能认证原任务此前请求的模型身份。',
]);

let cachedArtifacts;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readVerified(file, expectedHash) {
  const bytes = readFileSync(new URL(file, VENDOR_ROOT));
  if (sha256(bytes) !== expectedHash) throw new Error(`ModelTrace artifact checksum mismatch: ${file}`);
  return bytes.toString('utf8');
}

function loadArtifacts() {
  if (cachedArtifacts) return cachedArtifacts;
  const provenance = JSON.parse(readFileSync(new URL('provenance.json', VENDOR_ROOT), 'utf8'));
  if (provenance.commit !== COMMIT) throw new Error('Unsupported ModelTrace snapshot');
  readVerified('fingerprint-core.js', SCORER_SHA256);
  readVerified('probe-output.mjs', provenance.files['probe-output.mjs'].sha256);
  const bank = JSON.parse(readVerified('unified_bank.json', BANK_SHA256));
  const probes = JSON.parse(readVerified('reference-probes.json', provenance.promptProtocol.derivedFileSha256));
  if (bank.schema !== 'robust-number-fingerprint-bank' || bank.models.length !== provenance.modelCount
    || probes.length !== RECOMMENDED_SAMPLES
    || probes.some((probe) => probe.condition !== 'environment-06' || probe.transport !== 'clean' || probe.system || probe.user_prefix)) {
    throw new Error('Invalid ModelTrace reference protocol');
  }
  cachedArtifacts = { bank, probes, provenance };
  return cachedArtifacts;
}

function reportSource(artifacts) {
  const provenance = artifacts?.provenance;
  return {
    name: 'ModelTrace',
    repository: REPOSITORY,
    commit: COMMIT,
    commitDate: '2026-09-30T22:09:42Z',
    license: 'MIT',
    bankSha256: BANK_SHA256,
    scorerSha256: SCORER_SHA256,
    artifactHashesVerified: Boolean(artifacts),
    bankBuiltAt: provenance?.bankBuiltAt ?? null,
    modelCount: provenance?.modelCount ?? null,
    referenceResponseCount: provenance?.referenceResponseCount ?? null,
    promptProtocol: {
      condition: 'environment-06',
      language: 'en',
      transport: 'clean',
      challengeIds: ['query-16', 'query-17', 'query-18'],
      expectedCounts: [301, 319, 327],
      source: `${REPOSITORY}/blob/${COMMIT}/challenge_suite.py`,
      seedPolicy: 'Only prompt order and local IDs are seeded; prompt text and model-generated numbers are not seeded.',
    },
    calibrationScope: 'upstream_reference_grouped_cross_validation_only',
    magpieTransportCalibrated: false,
    sameContextCalibrated: false,
    multilingualCalibrated: false,
  };
}

/**
 * Use the exact clean JSON prompts that produced upstream environment-06 rows.
 * Seed permutes these fixed prompts; it is never sent to the model. The caller
 * must run each probe in an independent test session with the same settings.
 * This does not create a fork or claim to inspect an existing task's requests.
 */
export function buildFingerprintProbes({ seed = 'magpie-codex-sentinel-v1', samples = 3 } = {}) {
  if (typeof seed !== 'string') throw new TypeError('Fingerprint seed must be a string');
  if (!Number.isInteger(samples) || samples < 1 || samples > RECOMMENDED_SAMPLES) {
    throw new RangeError('Fingerprint samples must be between 1 and 3; upstream calibration covers only these counts');
  }
  const { probes } = loadArtifacts();
  return probes.map((probe) => ({ probe, order: sha256(`${seed}\0${probe.challenge_id}`) }))
    .sort((left, right) => left.order < right.order ? -1 : left.order > right.order ? 1 : 0)
    .slice(0, samples)
    .map(({ probe, order }) => ({
      id: `fingerprint-${probe.challenge_id}-${order.slice(0, 10)}`,
      family: 'fingerprint',
      prompt: probe.prompt,
      expectedCount: probe.expected_count,
      referenceCondition: probe.condition,
      referenceChallengeId: probe.challenge_id,
    }));
}

/**
 * Return auxiliary report data only. No thresholds, model switching, tool
 * blocking or capability-degradation decisions are made by this module.
 * Invalid output is rejected before the upstream permissive parser sees it.
 */
export function analyzeFingerprint(samples = []) {
  if (!Array.isArray(samples)) throw new TypeError('Fingerprint samples must be an array');
  if (samples.length > RECOMMENDED_SAMPLES) {
    throw new RangeError('Analyze at most 3 fingerprint samples per batch; larger batches lack matching calibration');
  }
  const base = {
    status: 'inconclusive',
    prediction: null,
    score: null,
    scoreKind: 'closed_set_similarity_weight',
    scoreUnit: 'fraction',
    margin: null,
    marginKind: 'top1_minus_top2_weight',
    sampleCount: samples.length,
    acceptedSamples: 0,
    rejectedSamples: 0,
    recommendedSamples: RECOMMENDED_SAMPLES,
    candidates: [],
    diagnostics: [],
    limitations: [...LIMITATIONS],
    source: reportSource(),
  };

  let artifacts;
  try {
    artifacts = loadArtifacts();
    base.source = reportSource(artifacts);
  } catch (error) {
    return { ...base, status: 'error', error: { code: 'fingerprint_assets_unavailable', message: error.message } };
  }

  const accepted = [];
  for (const [index, sample] of samples.entries()) {
    const expectedCount = sample?.expectedCount;
    if (!Number.isSafeInteger(expectedCount) || expectedCount <= 0) {
      base.diagnostics.push({ index, accepted: false, code: 'invalid_expected_count', expectedCount: null });
      continue;
    }
    try {
      const numbers = validateNumbers(sample?.text, expectedCount);
      accepted.push({ text: sample.text, expected_count: expectedCount });
      base.diagnostics.push({
        index, accepted: true, code: 'accepted', expectedCount,
        receivedCount: numbers.length,
        minimumCount: Math.max(80, Math.ceil(expectedCount * 0.55)),
        maximumCount: Math.ceil(expectedCount * 1.25),
      });
    } catch (error) {
      base.diagnostics.push({ index, accepted: false, ...(error.diagnostic || { code: 'invalid_output' }), message: error.message });
    }
  }
  base.acceptedSamples = accepted.length;
  base.rejectedSamples = samples.length - accepted.length;
  if (!accepted.length) return { ...base, reason: samples.length ? 'no_valid_samples' : 'no_samples' };

  try {
    const result = analyzeGlobalOutputs(accepted, artifacts.bank);
    if (!result.results.length || result.results.some((candidate) => !Number.isFinite(candidate.probability))) {
      throw new Error('ModelTrace returned non-finite candidate weights');
    }
    const [top, second] = result.results;
    return {
      ...base,
      status: accepted.length === RECOMMENDED_SAMPLES ? 'reported' : 'partial',
      prediction: top.model,
      score: top.probability,
      margin: top.probability - (second?.probability ?? 0),
      familyPrediction: result.family_prediction,
      familyScore: result.family_probability,
      candidates: result.results.map((candidate) => ({
        model: candidate.model,
        weight: candidate.probability,
        rawScore: candidate.score,
        profileSimilarity: candidate.profile_similarity,
        family: candidate.family,
      })),
      upstreamReferenceCalibration: {
        queryCount: Number(result.calibration.queries),
        beta: result.calibration.beta,
        cvAccuracy: result.calibration.cv_accuracy,
        applicableToMagpie: false,
      },
    };
  } catch (error) {
    return { ...base, status: 'error', error: { code: 'fingerprint_scoring_failed', message: error.message } };
  }
}
