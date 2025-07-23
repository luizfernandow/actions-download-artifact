import * as core from '@actions/core';
import * as github from '@actions/github';
import AdmZip from 'adm-zip';
import * as pathname from 'path';
import * as fs from 'fs';
import axios from 'axios';

interface Artifact {
  id: number;
  name: string;
  size_in_bytes: number;
  updated_at: string;
  expired: boolean;
}

function getLatest(artifacts: Artifact[]): Artifact {
  return artifacts.reduce((prev, cur, index) => {
    const prevDate = new Date(prev.updated_at);
    const curDate = new Date(cur.updated_at);
    return curDate > prevDate && index ? cur : prev;
  });
}

async function get(url: string) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return response.data;
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
    const [owner, repo]: string[] = core.getInput("repo", { required: true }).split("/");
    
    // optional
    let path: string = core.getInput("path", { required: false });
    if (!path) {
      path = "./";
    }
    const artifactName: string = core.getInput("name", { required: false });
    const latest_input: string = core.getInput("latest", { required: false });
    const latest: boolean = latest_input ? latest_input.toLowerCase() === 'true' : false;

    const client = github.getOctokit(token);

    console.log('input', path, artifactName, latest);
    console.log("==> Repo:", owner + "/" + repo);

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
      console.log('Get latest artifact');
      const latestArtifact = getLatest(artifacts);
      if (latestArtifact) {
        console.log('Latest artifact', latestArtifact);
        artifacts = [latestArtifact];
      }
    }

    if (artifacts.length) {
      const grouped: Record<string, Artifact[]> = {};
      for (const artifact of artifacts) {
        if (!grouped[artifact.name]) {
          grouped[artifact.name] = [];
        }
        grouped[artifact.name].push(artifact);
      }
      artifacts = Object.values(grouped).map((group) => getLatest(group));
    }

    console.log('Artifacts', artifacts);

    if (artifacts.length) {
      console.log("==> Found", artifacts.length, "artifacts");
      core.setOutput('found-artifact', true);
      core.setOutput('path', pathname.resolve(path));

      for (const artifact of artifacts) {
        console.log("==> Artifact:", artifact.id);

        const size = formatBytes(artifact.size_in_bytes);
        console.log("==> Downloading:", artifact.name + ".zip", `(${size})`);

        const { url } = await client.rest.actions.downloadArtifact({
          owner: owner,
          repo: repo,
          artifact_id: artifact.id,
          archive_format: "zip",
        });

        const zipFileBuffer = await get(url);

        const dir = artifactName ? path : pathname.join(path, artifact.name);
        fs.mkdirSync(dir, { recursive: true });

        const adm = new AdmZip(Buffer.from(zipFileBuffer));
        adm.getEntries().forEach((entry) => {
          const action = entry.isDirectory ? "creating" : "inflating";
          const filepath = pathname.join(dir, entry.entryName);
          console.log(`  ${action}: ${filepath}`);
        });

        adm.extractAllTo(dir, true);
      }
    } else {
      console.log("No artifacts found");
      core.setOutput('found-artifact', false);
      core.setOutput('path', '');
    }
  } catch (error) {
    core.setFailed((error as Error).message);
  }
}

downloadArtifact();