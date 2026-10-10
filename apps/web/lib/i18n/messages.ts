type Translate = (
  path: string,
  vars?: Record<string, string | number>,
) => string;

const EXACT: Record<string, string> = {
  Failed: "errors.failed",
  REQUEST_FAILED: "errors.failed",
  "Load failed": "errors.loadFailed",
  "Poll failed": "errors.pollFailed",
  "Run failed": "errors.runFailed",
  "Invalid step JSON": "errors.invalidStepJson",
  "Issue not found": "errors.issueNotFound",
  "Scenario not found": "errors.scenarioNotFound",
  "Step not found": "errors.stepNotFound",
  "Scenario run not found": "errors.runNotFound",
  "Environment not found": "errors.envNotFound",
  "Suite not found": "errors.suiteNotFound",
  "Test case not found": "errors.testCaseNotFound",
  "Test run not found": "errors.testRunNotFound",
  "name is required": "errors.nameRequired",
  "variable key is required": "errors.variableKeyRequired",
  "key and title are required": "errors.keyTitleRequired",
  "baseUrl, email and apiToken are required": "errors.credentialsRequired",
  "Jira is not configured": "errors.jiraNotConfigured",
  "Invalid issue key format": "errors.invalidIssueKey",
  "Issue key already exists": "errors.duplicateKey",
  "Spreadsheet has no sheets": "errors.noSheets",
  "No valid rows found. Need at least key + title columns.":
    "errors.noValidRows",
  "Analysis was manually edited; refuse automatic overwrite":
    "errors.analysisEdited",
  "Strategy was manually edited; refuse automatic overwrite":
    "errors.strategyEdited",
  "Cannot record NOT_RUN as an execution": "errors.cannotRecordNotRun",
  "Only image and video files are accepted": "errors.mediaType",
  "File is too large": "errors.mediaTooLarge",
  "Attachment not found": "errors.attachmentNotFound",
  "Invalid attachment owner": "errors.invalidAttachmentOwner",
  "kind must be SMOKE, REGRESSION, or CUSTOM": "errors.invalidSuiteKind",
  "variable key must match [a-zA-Z_][a-zA-Z0-9_]* for {{key}} usage":
    "errors.variableKeyFormat",
  "Host is not allowed": "errors.hostNotAllowed",
  "Port is invalid": "errors.portInvalid",
  "Database name is required": "errors.databaseRequired",
  "Username is required": "errors.usernameRequired",
  "Password is required": "errors.passwordRequired",
  "Connector name is required": "errors.connectorNameRequired",
  "Connector name already exists": "errors.connectorNameExists",
  "Database connector not found": "errors.connectorNotFound",
  "Connector is inactive": "errors.connectorInactive",
  "Query is empty": "errors.queryEmpty",
  "Query is too long": "errors.queryTooLong",
  "Only one statement is allowed": "errors.oneStatement",
  "Comments are not allowed in queries": "errors.commentsNotAllowed",
  "Statement is not allowed": "errors.statementNotAllowed",
  "This operation does not allow that statement": "errors.operationMismatch",
  "Database step is invalid": "errors.databaseStepInvalid",
  "Invalid connector": "errors.invalidConnector",
  "Oracle driver is not installed": "errors.oracleMissing",
  "Database request timed out": "errors.databaseTimeout",
  "Network request failed": "errors.network",
  "Unexpected error": "errors.unexpected",
  "You do not have permission to perform this action.": "errors.forbidden",
  "Jira issue could not be updated.": "errors.jiraUpdateFailed",
  "Unable to connect to the selected database.": "errors.unableToConnect",
  "Database authentication failed. Check the username and password.":
    "errors.databaseAuth",
  "Comment is required": "errors.commentRequired",
  "Comment is too long": "errors.commentTooLong",
  "This status change is not allowed.": "errors.statusNotAllowed",
  "Expected result is required": "errors.expectedRequired",
  "Bug not found": "errors.bugNotFound",
  "Title is required": "errors.titleRequired",
  "Select at least one test case": "errors.selectTestCase",
  "Connection options are too long": "errors.optionsTooLong",
  "Severity is invalid": "errors.levelInvalid",
  "Priority is invalid": "errors.levelInvalid",
  "The record no longer exists. Reload the page and try again.": "errors.recordGone",
  "A record with the same unique value already exists.": "errors.duplicate",
  "A referenced record does not exist. Reload the page and try again.": "errors.missingReference",
  "Only a failed test run can create a bug": "errors.bugNeedsFailedRun",
  "stepIds must list every step of this scenario exactly once": "errors.reorderMismatch",
  "stepIds must be a list of step ids": "errors.reorderMismatch",
  "Jira could not be reached. Check the Jira base URL and your network connection.": "errors.jiraUnreachable",
  "Jira rejected the credentials. Check the email and API token in Settings.": "errors.jiraAuth",
  "The Jira account does not have permission for this issue or project.": "errors.jiraForbidden",
  "Jira is rate limiting requests. Try again in a minute.": "errors.jiraRateLimited",
  "Jira base URL must be a valid http(s) URL": "errors.jiraBaseUrl",
  "Run was interrupted because the API restarted before it finished": "errors.runInterrupted",
  "Invalid test case": "errors.invalidInput",
  "Invalid test run": "errors.invalidInput",
  "Invalid suite": "errors.invalidInput",
  "JSON body is not valid JSON after variable substitution": "errors.invalidJsonBody",
  "No HTTP response available for response mapping": "errors.noMappingResponse",
  "Paste at least one cURL command": "errors.curlEmpty",
  "The pasted text is too long": "errors.curlTooLong",
  "No cURL command found": "errors.curlNone",
  "Import at most 50 requests at a time": "errors.curlTooMany",
  "No valid cURL command to import": "errors.curlNoneValid",
  "This suggestion is no longer available": "errors.suggestionGone",
  "A manual mapping already exists for this field": "errors.manualMappingExists",
  "The mapping source must be a step of this scenario": "errors.mappingSourceScenario",
  "The mapping source must run before this step": "errors.mappingSourceOrder",
  "A mapping needs a target field and a source": "errors.mappingInvalid",
  "Only HTTP steps take dependency mappings": "errors.mappingHttpOnly",
  "This run is not waiting for input": "errors.notWaiting",
  "Choose a target field and a value": "errors.chooseTargetValue",
  "AI analysis was cancelled": "errors.aiCancelled",
  "No Chrome, Chromium or Edge was found for UI steps. Install Google Chrome or set UI_BROWSER_PATH.": "errors.noBrowser",
  "Another recording is still open; stop it first": "errors.recordingOpen",
  "Nothing was recorded": "errors.nothingRecorded",
  "Enter the start URL (http:// or https://)": "errors.startUrlRequired",
  "The secret value of this action is missing; type it again in the step": "errors.secretMissing",
  "The analysis reached its time limit": "errors.aiTimeLimit",
  "The service limits the answer length; the complete part of the answer was kept": "errors.aiAnswerCapped",
  "The model reached its writing time limit; this step was shortened": "errors.aiAnswerCut",
  "The model reached its writing time limit before writing anything usable": "errors.aiNothingWritten",
  "Run the analysis first": "errors.runAnalysisFirst",
  "Write the acceptance criterion": "errors.writeCriterion",
  "Criteria imported from Jira are edited on the Jira page": "errors.criterionFromJira",
  "Acceptance criterion not found": "errors.recordGone",
  "Edge case not found": "errors.recordGone",
  "Risk not found": "errors.recordGone",
  "Automation suggestion not found": "errors.recordGone",
  "Document not found": "errors.recordGone",
  "Guideline not found": "errors.recordGone",
  "AI connection not found": "errors.recordGone",
  "Choose a file": "errors.chooseFile",
  "The document is too large (max 15 MB)": "errors.documentTooLarge",
  "Supported documents: .md, .txt, .pdf, .docx": "errors.documentType",
  "The document could not be read": "errors.documentUnreadable",
  "The document has no readable text": "errors.documentEmpty",
  "The document text is too long (max 400,000 characters)": "errors.documentTooLong",
  "Choose a model": "errors.chooseModel",
  "Only Ollama connections can download models": "errors.ollamaOnly",
  "Invalid model name": "errors.invalidModel",
  "Write the guideline (up to 600 characters)": "errors.writeGuideline",
  "AI base URL must be a valid http(s) URL": "errors.aiBaseUrl",
  "Unsupported framework": "errors.exportUnsupportedFramework",
  "Unsupported language for this framework": "errors.exportUnsupportedLanguage",
  "This precondition has no steps to export": "errors.exportNothing",
  "No AI provider is available in this workspace": "errors.exportNoProvider",
  "The selected AI provider is not available": "errors.exportProviderUnavailable",
  "The AI provider did not answer in time": "errors.exportTimeout",
  "The AI provider returned an empty answer": "errors.exportEmpty",
  "The AI provider returned an invalid answer": "errors.exportInvalid",
  "The AI provider's answer was cut off before the code was complete": "errors.exportCutOff",
};

const CURL_CODES = new Set(["missing_url", "unclosed_quote", "missing_value", "file_body", "bad_url"]);

/** "Step 2 (Login)" in the active language. */
function stepLabel(text: string, t: Translate) {
  const match = /^Step (\d+) \((.*)\)$/.exec(text);
  return match ? t("scenarios.flow.stepRef", { n: match[1]!, name: match[2]! }) : text;
}

/** A step not sent because a saved mapping had no value (several are joined with "; "). */
function localizeBlocked(text: string, t: Translate): string | null {
  if (!text.startsWith("Blocked: ")) return null;
  return text
    .split("; ")
    .map((part) => {
      let match = /^Blocked: (.+) has no successful response in this run \(needed for (.+)\)$/.exec(part);
      if (match) return t("errors.blockedNotRun", { step: stepLabel(match[1]!, t), target: match[2]! });
      match = /^Blocked: (.+) returned several values that could be (.+) \(needed for (.+)\)$/.exec(part);
      if (match) return t("errors.blockedAmbiguous", { step: stepLabel(match[1]!, t), path: match[2]!, target: match[3]! });
      match = /^Blocked: (.+) did not provide (.+) for (.+)$/.exec(part);
      if (match) return t("errors.blockedMissing", { step: stepLabel(match[1]!, t), path: match[2]!, target: match[3]! });
      return part;
    })
    .join(" ");
}

const EXTRACTION_REASONS: Record<string, string> = {
  "not found in the response": "errors.extractionReasons.missing",
  "the value is null": "errors.extractionReasons.null",
  "the response body is empty": "errors.extractionReasons.empty",
  "the response body is not JSON": "errors.extractionReasons.notJson",
};

/** Response-mapping and variable messages carry several values each. */
function localizeVariableMessage(text: string, t: Translate): string | null {
  let match = /^Variable (\{\{[^}]+\}\}) was not produced: step (\d+) \((.*)\) did not provide it$/.exec(text);
  if (match) return t("errors.variableNotProduced", { name: match[1]!, n: match[2]!, step: match[3]! });
  match = /^Variable (\{\{[^}]+\}\}) is used before step (\d+) \((.*)\) produces it$/.exec(text);
  if (match) return t("errors.variableUsedEarly", { name: match[1]!, n: match[2]!, step: match[3]! });
  match = /^Variable (\{\{[^}]+\}\}) contains a line break and cannot be used in a header$/.exec(text);
  if (match) return t("errors.headerLineBreak", { name: match[1]! });
  if (text.startsWith("Extraction failed for ")) {
    // Several failed mappings of one step are joined with "; ".
    const parts = text.split("; ").map((part) => {
      const hit = /^Extraction failed for (\{\{[^}]+\}\}) \((.*)\): (.*)$/.exec(part);
      if (!hit) return part;
      const reasonKey = EXTRACTION_REASONS[hit[3]!];
      return t("errors.extractionFailed", { name: hit[1]!, target: hit[2]!, reason: reasonKey ? t(reasonKey) : hit[3]! });
    });
    return parts.join(" ");
  }
  return null;
}

function extractMessage(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
    if (Array.isArray(parsed.message)) {
      return parsed.message.filter((item) => typeof item === "string").join(" ");
    }
  } catch {
    // keep raw text
  }
  return trimmed;
}

/** Map known API/client messages onto the active dictionary. Unknown text is kept. */
export function localizeUserMessage(raw: string, t: Translate): string {
  const text = extractMessage(raw);
  const exact = EXACT[text];
  if (exact) return t(exact);
  const variable = localizeVariableMessage(text, t);
  if (variable) return variable;
  const unavailable = /^AI analysis is not available:\s*(\w+)$/.exec(text);
  if (unavailable) {
    const code = unavailable[1]!;
    return t(code === "none" ? "studio.runner.notReady" : `errors.aiBlocked.${code}`);
  }
  const everywhere = /^AI (\w+) failed on every connection — (.*)$/.exec(text);
  if (everywhere) return t("errors.aiAllFailed", { detail: everywhere[2]! });
  const blocked = localizeBlocked(text, t);
  if (blocked) return blocked;
  const curl = /^cURL (\w+)$/.exec(text);
  if (curl && CURL_CODES.has(curl[1]!)) return t(`scenarios.curlErrors.${curl[1]}`);

  const prefixed: Array<[RegExp, string, string]> = [
    [/^Unknown StepType:\s*(.+)$/, "errors.unknownStep", "value"],
    [/^Invalid response mapping\s*(.+)$/, "errors.invalidMapping", "value"],
    [/^Invalid status:\s*(.+)$/, "errors.invalidStatus", "value"],
    [/^Run finished:\s*(.+)$/, "errors.runFinished", "status"],
    [/^AI analysis is not available:\s*(.+)$/, "errors.aiNotAvailable", "reason"],
    [/^Unresolved variable:\s*(.+)$/, "errors.unresolvedVariable", "value"],
    [/^SSRF protection blocked host:\s*(.+)$/, "errors.hostBlocked", "value"],
    [/^The response reports an error \([^)]*\):\s*(.+)$/, "errors.responseReportsError", "value"],
    [/^Element not found:\s*(.+)$/, "errors.uiElementNotFound", "value"],
    [/^Ambiguous element:\s*(.+)$/, "errors.uiAmbiguous", "value"],
    [/^AUTHENTICATION_STATE_EXPIRED:\s*(.+)$/, "errors.uiAuthExpired", "value"],
    [/^The page shows an error:\s*(.+)$/, "errors.uiPageError", "value"],
    [/^Request timed out after\s*(\d+) ms$/, "errors.requestTimeout", "value"],
    [/^Jira issue (\S+) was not found/, "errors.jiraIssueMissing", "value"],
    [/^Jira returned an error \(HTTP (\d+)\)/, "errors.jiraHttp", "value"],
    [/^Invalid (?:test case field|test run|suite):\s*(.+)$/, "errors.invalidField", "value"],
    [/^The generated code was rejected:\s*(.+)$/, "errors.exportRejected", "value"],
    [/^Code generation failed:\s*(.+)$/, "errors.exportFailed", "value"],
  ];
  for (const [pattern, path, varName] of prefixed) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const value =
      varName === "status"
        ? (() => {
            const key = `status.${match[1]}`;
            const translated = t(key);
            return translated === key ? match[1] : translated;
          })()
        : match[1];
    return t(path, { [varName]: value });
  }

  return text;
}
