/** Real PR endpoints; no refresh/import or GitHub write operations exist. */
export interface PrRepository {
  owner: string;
  name: string;
  nameWithOwner: string;
  url: string;
}

export interface PrReviewSummary {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  baseRefOid: string;
  author: { login: string } | null;
}

export interface PrContext {
  mode: "workspace" | "pr";
  repository: PrRepository | null;
  originalWorkspaceUrl: string | null;
  pullRequest: PrReviewSummary | null;
  capabilities: {
    list: true;
    open: true;
    refresh: false;
    submit: false;
    dismiss: false;
    threads: false;
  };
}

export interface PrListResult {
  repository: PrRepository;
  pullRequests: PrReviewSummary[];
  scope: "review-involves";
  limit: 50;
}

export interface PrOpenResult {
  url: string;
}
