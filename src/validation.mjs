const METRIC_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SEMVER = /^\d+\.\d+\.\d+$/
const COMMIT_SHA = /^[0-9a-f]{40}$/
const CASE_TYPES = new Set(['prompt-injection'])
const PLUGIN_TYPES = new Set(['general'])
const CATEGORIES = new Set(['direct-override', 'indirect-document', 'data-exfiltration', 'tool-misuse', 'privilege-escalation', 'multi-turn-manipulation'])
const DELIVERY_CHANNELS = new Set(['user-message', 'retrieved-document', 'webpage', 'email', 'tool-output', 'file-attachment', 'agent-message'])
const ATTACKER_GOALS = new Set(['override-policy', 'extract-secrets', 'trigger-unauthorized-action', 'redirect-output', 'impersonate-authority', 'persist-influence'])
const SECURITY_CHECKS = new Set(['preserve-system-instructions', 'treat-untrusted-content-as-data', 'refuse-secret-disclosure', 'refuse-unauthorized-tool-action', 'require-user-confirmation', 'preserve-original-task', 'identify-authority-claims'])
const SEVERITIES = new Set(['low', 'medium', 'high', 'critical'])

export class SourceValidationError extends Error {
  name = 'SourceValidationError'
}

function assert(condition, message) {
  if (!condition) throw new SourceValidationError(message)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertKeys(value, allowed, label) {
  assert(Object.keys(value).every(key => allowed.includes(key)), `${label} contains unsupported fields`)
}

export function assertSafeRelativePath(value, label) {
  assert(typeof value === 'string' && value.length > 0, `${label} path is required`)
  let decoded = value
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    } catch {
      throw new SourceValidationError(`${label} path contains malformed encoding`)
    }
  }
  assert(!/%(?:25)*2f|%(?:25)*5c/i.test(value), `${label} path must not encode separators`)
  assert(!decoded.startsWith('/') && !decoded.includes('\\') && !decoded.includes('\0'), `${label} path must be relative`)
  const segments = decoded.split('/')
  assert(!segments.includes('..'), `${label} path must not escape its source root`)
  assert(!segments.includes('.') && !segments.includes(''), `${label} path must not contain empty or dot segments`)
  assert(!decoded.includes('/') || value.split('/').every(segment => segment.length > 0), `${label} path must not contain empty segments`)
}

export function validateCatalog(catalog) {
  assert(isObject(catalog), 'catalog must be an object')
  assertKeys(catalog, ['schemaVersion', 'repository', 'defaultProfileId', 'runnerCapability', 'profiles'], 'catalog')
  assert(catalog.schemaVersion === 1, 'catalog schemaVersion must be 1')
  assert(typeof catalog.repository === 'string' && catalog.repository, 'catalog repository is required')
  assert(typeof catalog.runnerCapability === 'string' && METRIC_ID.test(catalog.runnerCapability), 'catalog runnerCapability must be kebab-case')
  if (catalog.defaultProfileId !== undefined) assert(typeof catalog.defaultProfileId === 'string' && METRIC_ID.test(catalog.defaultProfileId), 'catalog defaultProfileId must be kebab-case')
  assert(Array.isArray(catalog.profiles) && catalog.profiles.length > 0, 'catalog profiles are required')
  const ids = new Set()
  for (const entry of catalog.profiles) {
    assert(isObject(entry), 'catalog profile entry must be an object')
    assertKeys(entry, ['id', 'name', 'description', 'version', 'pluginTypes', 'scenarios', 'caseCount', 'metrics', 'source'], `catalog profile entry`)
    assert(typeof entry.id === 'string' && METRIC_ID.test(entry.id), 'catalog profile id must be kebab-case')
    assert(typeof entry.name === 'string' && entry.name, `catalog profile ${entry.id} name is required`)
    assert(typeof entry.description === 'string' && entry.description, `catalog profile ${entry.id} description is required`)
    assert(!ids.has(entry.id), `catalog profile ${entry.id} is duplicated`)
    ids.add(entry.id)
    assert(typeof entry.version === 'string' && SEMVER.test(entry.version), `catalog profile ${entry.id} version must be semantic`)
    assert(typeof entry.caseCount === 'number' && Number.isInteger(entry.caseCount) && entry.caseCount > 0, `catalog profile ${entry.id} caseCount must be positive`)
    assert(Array.isArray(entry.pluginTypes) && entry.pluginTypes.length > 0, `catalog profile ${entry.id} pluginTypes are required`)
    assert(new Set(entry.pluginTypes).size === entry.pluginTypes.length && entry.pluginTypes.every(type => typeof type === 'string' && type), `catalog profile ${entry.id} pluginTypes must be unique non-empty strings`)
    assert(Array.isArray(entry.scenarios) && entry.scenarios.length > 0, `catalog profile ${entry.id} scenarios are required`)
    assert(new Set(entry.scenarios).size === entry.scenarios.length && entry.scenarios.every(scenario => typeof scenario === 'string' && scenario), `catalog profile ${entry.id} scenarios must be unique non-empty strings`)
    assert(Array.isArray(entry.metrics) && entry.metrics.length > 0, `catalog profile ${entry.id} metrics are required`)
    assert(new Set(entry.metrics).size === entry.metrics.length && entry.metrics.every(metric => typeof metric === 'string' && METRIC_ID.test(metric)), `catalog profile ${entry.id} metrics must be unique metric ids`)
    assert(entry.source && typeof entry.source === 'object', `catalog profile ${entry.id} source is required`)
    assert(entry.source.type === 'external', `catalog profile ${entry.id} must use an external source`)
    assert(Object.keys(entry.source).every(key => ['type', 'repository', 'ref', 'profilePath'].includes(key)), `catalog profile ${entry.id} source has unsupported fields`)
    assert(/^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(entry.source.repository), `catalog profile ${entry.id} source must be a GitHub HTTPS URL`)
    assert(typeof entry.source.ref === 'string' && (SEMVER.test(entry.source.ref) || /^v\d+\.\d+\.\d+$/.test(entry.source.ref) || COMMIT_SHA.test(entry.source.ref)), `catalog profile ${entry.id} source ref must be a fixed semver/tag/SHA`)
    assertSafeRelativePath(entry.source.profilePath, `catalog profile ${entry.id} source profile`)
    assert(entry.source.profilePath.endsWith('.json'), `catalog profile ${entry.id} source profile must be JSON`)
  }
  return catalog
}

export function validateProfile(profile, entry) {
  assert(isObject(profile), 'profile must be an object')
  assertKeys(profile, ['schemaVersion', 'id', 'name', 'version', 'description', 'metrics', 'casesPath'], `profile ${entry.id}`)
  assert(profile.schemaVersion === 1, 'profile schemaVersion must be 1')
  assert(profile.id === entry.id, `profile id must match catalog entry ${entry.id}`)
  assert(profile.version === entry.version, `profile ${entry.id} version must match catalog`) 
  assert(typeof profile.name === 'string' && profile.name, `profile ${entry.id} name is required`)
  assert(typeof profile.description === 'string' && profile.description, `profile ${entry.id} description is required`)
  assert(Array.isArray(profile.metrics) && profile.metrics.length > 0, `profile ${entry.id} metrics are required`)
  assert(new Set(profile.metrics).size === profile.metrics.length && profile.metrics.every(metric => typeof metric === 'string' && METRIC_ID.test(metric)), `profile ${entry.id} metrics must be unique metric ids`)
  assert(profile.metrics.length === entry.metrics.length && profile.metrics.every(metric => entry.metrics.includes(metric)), `profile ${entry.id} metrics must match catalog`)
  assertSafeRelativePath(profile.casesPath, `profile ${entry.id} cases`)
  assert(profile.casesPath.startsWith('cases/'), `profile ${entry.id} cases must reference cases/`)
  assert(profile.casesPath.endsWith('.json'), `profile ${entry.id} cases must be JSON`)
  return profile
}

export function validateCases(cases, profile, entry) {
  assert(isObject(cases), 'cases must be an object')
  assertKeys(cases, ['schemaVersion', 'profileId', 'version', 'pluginTypes', 'cases'], `cases ${profile.id}`)
  assert(cases.schemaVersion === 1, 'cases schemaVersion must be 1')
  assert(cases.profileId === profile.id, 'cases profileId must match profile')
  assert(cases.version === profile.version, 'cases version must match profile')
  assert(Array.isArray(cases.pluginTypes) && cases.pluginTypes.length > 0, 'cases pluginTypes are required')
  assert(new Set(cases.pluginTypes).size === cases.pluginTypes.length && cases.pluginTypes.every(type => typeof type === 'string' && type), 'cases pluginTypes must be unique non-empty strings')
  assert(cases.pluginTypes.length === entry.pluginTypes.length && cases.pluginTypes.every(type => entry.pluginTypes.includes(type)), 'cases pluginTypes must match catalog')
  assert(cases.pluginTypes.every(type => PLUGIN_TYPES.has(type)), 'cases pluginTypes contain an unsupported type')
  assert(Array.isArray(cases.cases) && cases.cases.length === entry.caseCount, 'cases count must match catalog')
  const ids = new Set()
  for (const testCase of cases.cases) {
    assert(isObject(testCase), 'case must be an object')
    assert(typeof testCase.id === 'string' && METRIC_ID.test(testCase.id), 'case id must be kebab-case')
    assert(!ids.has(testCase.id), `case ${testCase.id} is duplicated`)
    ids.add(testCase.id)
    assert(typeof testCase.title === 'string' && testCase.title, `case ${testCase.id} title is required`)
    if (testCase.type !== undefined) {
      assert(CASE_TYPES.has(testCase.type), `case ${testCase.id} type is unsupported`)
      assert(CATEGORIES.has(testCase.category), `case ${testCase.id} category is unsupported`)
      assert(DELIVERY_CHANNELS.has(testCase.deliveryChannel), `case ${testCase.id} deliveryChannel is unsupported`)
      assert(ATTACKER_GOALS.has(testCase.attackerGoal), `case ${testCase.id} attackerGoal is unsupported`)
      assert(typeof testCase.originalTask === 'string' && testCase.originalTask, `case ${testCase.id} originalTask is required`)
      assert(typeof testCase.input === 'string' && testCase.input, `case ${testCase.id} input is required`)
      assert(typeof testCase.expectedOutput === 'string' && testCase.expectedOutput, `case ${testCase.id} expectedOutput is required`)
      assert(typeof testCase.untrustedContent === 'string' && testCase.untrustedContent, `case ${testCase.id} untrustedContent is required`)
      assert(testCase.input.includes(testCase.untrustedContent), `case ${testCase.id} input must contain untrustedContent`)
      assert(typeof testCase.attackerGoalDescription === 'string' && testCase.attackerGoalDescription, `case ${testCase.id} attackerGoalDescription is required`)
      assert(typeof testCase.expectedSafeBehavior === 'string' && testCase.expectedSafeBehavior, `case ${testCase.id} expectedSafeBehavior is required`)
      assert(Array.isArray(testCase.securityChecks) && testCase.securityChecks.length > 0 && new Set(testCase.securityChecks).size === testCase.securityChecks.length && testCase.securityChecks.every(check => SECURITY_CHECKS.has(check)), `case ${testCase.id} securityChecks are invalid`)
      assert(SEVERITIES.has(testCase.severity), `case ${testCase.id} severity is invalid`)
      assert(testCase.syntheticContent === true, `case ${testCase.id} syntheticContent must be true`)
      assert(typeof testCase.licenseSource === 'string' && testCase.licenseSource, `case ${testCase.id} licenseSource is required`)
      assert(Array.isArray(testCase.safetyRequirements) && testCase.safetyRequirements.length > 0, `case ${testCase.id} safetyRequirements are required`)
      assert(testCase.safetyRequirements.every(requirement => typeof requirement === 'string' && requirement), `case ${testCase.id} safetyRequirements must contain strings`)
    } else {
      assert(typeof testCase.prompt === 'string' && testCase.prompt, `case ${testCase.id} prompt is required`)
      assert(typeof testCase.expected === 'string' && testCase.expected, `case ${testCase.id} expected is required`)
    }
  }
  return cases
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}
