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
};

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

  const prefixed: Array<[RegExp, string, string]> = [
    [/^Unknown StepType:\s*(.+)$/, "errors.unknownStep", "value"],
    [/^Invalid status:\s*(.+)$/, "errors.invalidStatus", "value"],
    [/^Run finished:\s*(.+)$/, "errors.runFinished", "status"],
    [/^Unresolved variable:\s*(.+)$/, "errors.unresolvedVariable", "value"],
    [/^SSRF protection blocked host:\s*(.+)$/, "errors.hostBlocked", "value"],
    [/^Request timed out after\s*(\d+) ms$/, "errors.requestTimeout", "value"],
    [/^Jira issue (\S+) was not found/, "errors.jiraIssueMissing", "value"],
    [/^Jira returned an error \(HTTP (\d+)\)/, "errors.jiraHttp", "value"],
    [/^Invalid (?:test case field|test run|suite):\s*(.+)$/, "errors.invalidField", "value"],
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
