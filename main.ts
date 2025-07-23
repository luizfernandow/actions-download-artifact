import * as core from '@actions/core';
import * as github from '@actions/github';
import { components } from '@octokit/openapi-types';
import AdmZip from 'adm-zip';
import * as pathname from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';

type Artifact = components["schemas"]["artifact"];

/**
 * Returns the latest artifact from a list based on updated_at.
 */
function getLatest(artifacts: Artifact[]): Artifact {
  return artifacts.reduce((prev, cur, index) => {
    const prevDate = new Date(prev.updated_at ?? '');
    const curDate = new Date(cur.updated_at ?? '');
    return curDate > prevDate && index ? cur : prev;
  });
}

/**
 * Groups artifacts by name and returns the latest from each group.
 */
function groupAndGetLatestArtifacts(artifacts: Artifact[]): Artifact[] {
  const grouped: Record<string, Artifact[]> = {};
  for (const artifact of artifacts) {
    if (!artifact.name) continue;
    if (!grouped[artifact.name]) {
      grouped[artifact.name] = [];
    }
    grouped[artifact.name].push(artifact);
  }
  return Object.values(grouped).map((group) => getLatest(group));
}

async function get(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`Failed to get '${url}' (${res.statusCode})`));
        return;
      }
      const data: Buffer[] = [];
      res.on('data', (chunk) => data.push(chunk));
      res.on('end', () => resolve(Buffer.concat(data)));
    }).on('error', reject);
  });
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1000;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

const downloadArtifact = async (): Promise<void> => {
  try {
    // required
    const token: string = core.getInput("github_token", { required: true });
    const repoInput = core.getInput("repo", { required: true });
    const [owner, repo] = repoInput.split("/");
    if (!owner || !repo) {
      throw new Error(`Invalid repo format: "${repoInput}". Expected "owner/repo".`);
    }

    // optional
    let path: string = core.getInput("path", { required: false });
    if (!path) {
      path = "./";
    }
    const artifactName: string = core.getInput("name", { required: false });
    const latest_input: string = core.getInput("latest", { required: false });
    const latest: boolean = latest_input ? latest_input.toLowerCase() === 'true' : false;

    const client = github.getOctokit(token);

    core.info(`input ${path} ${artifactName} ${latest}`);
    core.info(`==> Repo: ${owner}/${repo}`);

    const artifactsEndpoint = "GET /repos/:owner/:repo/actions/artifacts";
    const artifactsEndpointParams = {
      owner: owner,
      repo: repo,
      per_page: 100
    };

    let artifacts: Artifact[] = [];

    for await (const artifactResponse of client.paginate.iterator(artifactsEndpoint, artifactsEndpointParams)) {
      artifacts = artifacts.concat((artifactResponse.data as Artifact[])
        .filter((artifact: Artifact) => !artifact.expired)
        .filter((artifact: Artifact) => artifactName ? artifact.name === artifactName : true)
      );
    }

    if (latest && artifacts.length) {
      core.info('Get latest artifact');
      const latestArtifact = getLatest(artifacts);
      if (latestArtifact) {
        core.info(`Latest artifact: ${latestArtifact.name}`);
        artifacts = [latestArtifact];
      }
    }

    if (artifacts.length) {
      artifacts = groupAndGetLatestArtifacts(artifacts);
    }

    core.info(`Artifacts: ${JSON.stringify(artifacts, null, 2)}`);

    if (artifacts.length) {
      core.info(`==> Found ${artifacts.length} artifacts`);
      core.setOutput('found-artifact', true);
      core.setOutput('path', pathname.resolve(path));

      for (const artifact of artifacts) {
        core.info(`==> Artifact: ${artifact.id}`);

        const size = formatBytes(artifact.size_in_bytes ?? 0);
        core.info(`==> Downloading: ${artifact.name}.zip (${size})`);

        const { url } = await client.rest.actions.downloadArtifact({
          owner: owner,
          repo: repo,
          artifact_id: artifact.id,
          archive_format: "zip",
        });

        const zipFileBuffer = await get(url);

        const dir = artifactName ? path : pathname.join(path, artifact.name ?? "artifact");
        await fs.promises.mkdir(dir, { recursive: true });

        const adm = new AdmZip(Buffer.from(zipFileBuffer));
        adm.getEntries().forEach((entry) => {
          const action = entry.isDirectory ? "creating" : "inflating";
          const filepath = pathname.join(dir, entry.entryName);
          core.info(`  ${action}: ${filepath}`);
        });

        adm.extractAllTo(dir, true);
      }
    } else {
      core.info("No artifacts found");
      core.setOutput('found-artifact', false);
      core.setOutput('path', '');
    }
  } catch (error) {
    core.setFailed(`Download failed: ${(error as Error).message}`);
  }
}

downloadArtifact();