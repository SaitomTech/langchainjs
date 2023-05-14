import binaryExtensions from "binary-extensions";
import { simpleGit, SimpleGit, CleanOptions } from "simple-git";
import { lstatSync, readFileSync } from "fs";
import * as glob from "glob";
import * as path from "path";
import { Document } from "../../document.js";
import { BaseDocumentLoader } from "../base.js";
import { UnknownHandling } from "../fs/directory.js";
import { extname } from "../../util/extname.js";

const extensions = new Set(binaryExtensions);

function isBinaryPath(name: string) {
  return extensions.has(extname(name).slice(1).toLowerCase());
}

interface GithubFile {
  path: string;
  type: "file" | "dir";
}

export interface GithubRepoLoaderParams {
  branch?: string;
  recursive?: boolean;
  unknown?: UnknownHandling;
  accessToken?: string;
  ignoreFiles?: (string | RegExp)[];
}

export class GithubRepoLoader
  extends BaseDocumentLoader
  implements GithubRepoLoaderParams
{
  private readonly owner: string;

  private readonly repo: string;

  private readonly initialPath: string;

  public branch: string;

  public recursive: boolean;

  public unknown: UnknownHandling;

  public accessToken?: string;

  public ignoreFiles: (string | RegExp)[];

  constructor(
    githubUrl: string,
    {
      accessToken = typeof process !== "undefined"
        ? // eslint-disable-next-line no-process-env
          process.env?.GITHUB_ACCESS_TOKEN
        : undefined,
      branch = "main",
      recursive = true,
      unknown = UnknownHandling.Warn,
      ignoreFiles = [],
    }: GithubRepoLoaderParams = {}
  ) {
    super();
    const { owner, repo, path } = this.extractOwnerAndRepoAndPath(githubUrl);
    this.owner = owner;
    this.repo = repo;
    this.initialPath = path;
    this.branch = branch;
    this.recursive = recursive;
    this.unknown = unknown;
    this.accessToken = accessToken;
    this.ignoreFiles = ignoreFiles;
  }

  private extractOwnerAndRepoAndPath(url: string): {
    owner: string;
    repo: string;
    path: string;
  } {
    const match = url.match(
      /https:\/\/github.com\/([^/]+)\/([^/]+)(\/tree\/[^/]+\/(.+))?/i
    );

    if (!match) {
      throw new Error("Invalid GitHub URL format.");
    }

    return { owner: match[1], repo: match[2], path: match[4] || "" };
  }

  public async load(): Promise<Document[]> {
    const documents: Document[] = [];
    await this.cloneRepo();
    await this.processDirectory(this.initialPath, documents);
    return documents;
  }

  private shouldIgnore(path: string): boolean {
    return this.ignoreFiles.some((pattern) => {
      if (typeof pattern === "string") {
        return path === pattern;
      }

      try {
        return pattern.test(path);
      } catch {
        throw new Error(`Unknown ignore file pattern: ${pattern}`);
      }
    });
  }

  private async cloneRepo() {
    const git: SimpleGit = simpleGit().clean(CleanOptions.FORCE);
    await git.clone(
      `https://${this.accessToken}@github.com/${this.owner}/${this.repo}`,
      {
        "--branch": this.branch,
      }
    );
  }

  private async processDirectory(
    path: string,
    documents: Document[]
  ): Promise<void> {
    try {
      const files = this.fetchRepoFiles(path);

      for (const file of files) {
        if (file.type === "dir") {
          if (this.recursive) {
            await this.processDirectory(file.path, documents);
          }
        } else {
          try {
            if (!isBinaryPath(file.path) && !this.shouldIgnore(file.path)) {
              const fileContent = this.fetchFileContent(file);
              const metadata = { source: file.path };
              documents.push(
                new Document({ pageContent: fileContent, metadata })
              );
            }
          } catch (e) {
            this.handleError(
              `Failed to fetch file content: ${file.path}, ${e}`
            );
          }
        }
      }
    } catch (error) {
      this.handleError(`Failed to process directory: ${path}, ${error}`);
    }
  }

  private fetchRepoFiles(filePath: string): GithubFile[] {
    const files = glob.sync(`${this.repo}/${filePath}/**/*`, { nodir: false });
    return files.map((file) => ({
      path: path.relative(`${this.repo}/${filePath}`, file),
      type: lstatSync(file).isDirectory() ? "dir" : "file",
    }));
  }

  private fetchFileContent(file: GithubFile): string {
    return readFileSync(`${this.repo}/${file.path}`, "utf-8");
  }

  private handleError(message: string): void {
    switch (this.unknown) {
      case UnknownHandling.Ignore:
        break;
      case UnknownHandling.Warn:
        console.warn(message);
        break;
      case UnknownHandling.Error:
        throw new Error(message);
      default:
        throw new Error(`Unknown unknown handling: ${this.unknown}`);
    }
  }
}
