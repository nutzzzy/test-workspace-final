export type NavItem = {
  href: string;
  label: string;
  icon: string;
};

export const APP_NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Dashboard", icon: "dashboard" },
  { href: "/jira", label: "Jira", icon: "jira" },
  { href: "/workspace", label: "Test Workspace", icon: "workspace" },
  { href: "/suites", label: "Test Suites", icon: "suites" },
  { href: "/scenarios", label: "Scenarios", icon: "scenarios" },
  { href: "/runs", label: "Test Runs", icon: "runs" },
  { href: "/bugs", label: "Bugs", icon: "bugs" },
  { href: "/environments", label: "Environments", icon: "environments" },
  { href: "/settings", label: "Settings", icon: "settings" },
] as const;

export const APP_NAME = "QA Workbench";
