/**
 * GitHub access via the `gh` CLI — reuses an existing login, and keeps this
 * repo free of any token handling beyond passing one through as an env var.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  url: string;
  labels: Array<{ name: string }>;
  stateReason?: string | null;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefName: string;
}

export class GitHubClient {
  constructor(
    private readonly repo: string,
    private readonly token?: string,
  ) {}

  private async gh(args: string[]): Promise<string> {
    const env = { ...process.env };
    if (this.token) env.GH_TOKEN = this.token;
    try {
      const { stdout } = await exec("gh", args, { env, maxBuffer: 32 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      const err = error as { stderr?: string; message?: string };
      throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${err.stderr?.trim() || err.message}`);
    }
  }

  async listIssues(opts: { labels?: string[]; state?: "open" | "closed" | "all"; limit?: number } = {}): Promise<Issue[]> {
    const args = [
      "issue",
      "list",
      "--repo",
      this.repo,
      "--state",
      opts.state ?? "open",
      "--limit",
      String(opts.limit ?? 200),
      "--json",
      "number,title,body,state,url,labels,stateReason",
    ];
    for (const label of opts.labels ?? []) args.push("--label", label);
    return JSON.parse(await this.gh(args)) as Issue[];
  }

  async createIssue(opts: { title: string; body: string; labels: string[] }): Promise<number> {
    const args = ["issue", "create", "--repo", this.repo, "--title", opts.title, "--body", opts.body];
    for (const label of opts.labels) args.push("--label", label);
    const url = (await this.gh(args)).trim().split("\n").at(-1) ?? "";
    const number = Number(url.split("/").at(-1));
    if (!Number.isFinite(number)) throw new Error(`Could not parse issue number from: ${url}`);
    return number;
  }

  async commentOnIssue(number: number, body: string): Promise<void> {
    await this.gh(["issue", "comment", String(number), "--repo", this.repo, "--body", body]);
  }

  async addLabels(number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.gh(["issue", "edit", String(number), "--repo", this.repo, "--add-label", labels.join(",")]);
  }

  /** Create a label if it does not exist. Idempotent. */
  async ensureLabel(name: string, color: string, description: string): Promise<void> {
    await this.gh([
      "label", "create", name, "--repo", this.repo,
      "--color", color, "--description", description, "--force",
    ]);
  }

  async listPullRequests(opts: { state?: "open" | "merged" | "closed" | "all"; limit?: number } = {}): Promise<PullRequest[]> {
    const out = await this.gh([
      "pr", "list", "--repo", this.repo,
      "--state", opts.state ?? "open",
      "--limit", String(opts.limit ?? 100),
      "--json", "number,title,url,state,headRefName",
    ]);
    return JSON.parse(out) as PullRequest[];
  }

  /** PRs that close a given issue, found via the issue's timeline. */
  async linkedPullRequest(issueNumber: number): Promise<PullRequest | null> {
    const out = await this.gh([
      "api",
      `repos/${this.repo}/issues/${issueNumber}/timeline`,
      "--jq",
      '[.[] | select(.event == "cross-referenced" and .source.issue.pull_request != null) | .source.issue] | last // empty',
    ]).catch(() => "");
    if (!out.trim()) return null;
    const issue = JSON.parse(out) as {
      number: number; title: string; html_url: string; state: string;
      pull_request?: { merged_at?: string | null };
    };
    return {
      number: issue.number,
      title: issue.title,
      url: issue.html_url,
      state: issue.pull_request?.merged_at ? "MERGED" : (issue.state.toUpperCase() as PullRequest["state"]),
      headRefName: "",
    };
  }
}
