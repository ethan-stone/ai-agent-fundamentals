import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type {
  Snapshot,
  SnapshotLocation,
  SnapshotManifest,
  SnapshotStorage,
} from "@strands-agents/sdk";

const MANIFEST = "manifest.json";
const SNAPSHOT_LATEST = "snapshot_latest.json";
const IMMUTABLE_HISTORY = "immutable_history";
const SNAPSHOT_REGEX = /snapshot_([\w-]+)\.json$/;
const SCHEMA_VERSION = "1.0";

export type CustomS3SnapshotStorageConfig = {
  bucket: string;
  prefix?: string;
  s3Client: S3Client;
};

function normalizePrefix(prefix?: string): string {
  if (!prefix) {
    return "";
  }

  return prefix.replace(/^\/+|\/+$/g, "");
}

export class CustomS3SnapshotStorage implements SnapshotStorage {
  private readonly prefix: string;

  constructor(private readonly config: CustomS3SnapshotStorageConfig) {
    this.prefix = normalizePrefix(config.prefix);
  }

  async saveSnapshot(params: {
    location: SnapshotLocation;
    snapshotId: string;
    isLatest: boolean;
    snapshot: Snapshot;
  }): Promise<void> {
    const key = params.isLatest
      ? this.getLatestSnapshotKey(params.location)
      : this.getHistorySnapshotKey(params.location, params.snapshotId);

    await this.writeJSON(key, params.snapshot);
  }

  async loadSnapshot(params: {
    location: SnapshotLocation;
    snapshotId?: string;
  }): Promise<Snapshot | null> {
    const key = params.snapshotId === undefined
      ? this.getLatestSnapshotKey(params.location)
      : this.getHistorySnapshotKey(params.location, params.snapshotId);

    return this.readJSON<Snapshot>(key);
  }

  async listSnapshotIds(params: {
    location: SnapshotLocation;
    limit?: number;
    startAfter?: string;
  }): Promise<string[]> {
    const prefix = this.getHistoryPrefix(params.location);
    const response = await this.config.s3Client.send(new ListObjectsV2Command({
      Bucket: this.config.bucket,
      Prefix: prefix,
      MaxKeys: params.limit ?? 1000,
      StartAfter: params.startAfter ? `${prefix}snapshot_${params.startAfter}.json` : undefined,
    }));

    return (response.Contents ?? [])
      .flatMap((entry) => entry.Key ? [entry.Key] : [])
      .map((key) => key.match(SNAPSHOT_REGEX)?.[1])
      .filter((snapshotId): snapshotId is string => Boolean(snapshotId));
  }

  async deleteSession(params: { sessionId: string }): Promise<void> {
    const prefix = this.getSessionPrefix(params.sessionId);
    let continuationToken: string | undefined;

    do {
      const response = await this.config.s3Client.send(new ListObjectsV2Command({
        Bucket: this.config.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));

      const objects = (response.Contents ?? [])
        .flatMap((entry) => entry.Key ? [{ Key: entry.Key }] : []);

      if (objects.length > 0) {
        await this.config.s3Client.send(new DeleteObjectsCommand({
          Bucket: this.config.bucket,
          Delete: { Objects: objects },
        }));
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  async loadManifest(params: { location: SnapshotLocation }): Promise<SnapshotManifest> {
    const manifest = await this.readJSON<SnapshotManifest>(this.getManifestKey(params.location));

    return manifest ?? {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
    };
  }

  async saveManifest(params: { location: SnapshotLocation; manifest: SnapshotManifest }): Promise<void> {
    await this.writeJSON(this.getManifestKey(params.location), params.manifest);
  }

  private getSessionPrefix(sessionId: string): string {
    return this.prefix ? `${this.prefix}/${sessionId}/` : `${sessionId}/`;
  }

  private getScopePrefix(location: SnapshotLocation): string {
    return `${this.getSessionPrefix(location.sessionId)}scopes/${location.scope}/${location.scopeId}/snapshots/`;
  }

  private getHistoryPrefix(location: SnapshotLocation): string {
    return `${this.getScopePrefix(location)}${IMMUTABLE_HISTORY}/`;
  }

  private getLatestSnapshotKey(location: SnapshotLocation): string {
    return `${this.getScopePrefix(location)}${SNAPSHOT_LATEST}`;
  }

  private getHistorySnapshotKey(location: SnapshotLocation, snapshotId: string): string {
    return `${this.getHistoryPrefix(location)}snapshot_${snapshotId}.json`;
  }

  private getManifestKey(location: SnapshotLocation): string {
    return `${this.getScopePrefix(location)}${MANIFEST}`;
  }

  private async writeJSON(key: string, data: unknown): Promise<void> {
    await this.config.s3Client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      Body: JSON.stringify(data, null, 2),
      ContentType: "application/json",
    }));
  }

  private async readJSON<T>(key: string): Promise<T | null> {
    try {
      const response = await this.config.s3Client.send(new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      }));

      const body = await response.Body?.transformToString();

      if (!body) {
        return null;
      }

      return JSON.parse(body) as T;
    } catch (error) {
      const details = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };

      if (details.name === "NoSuchKey" || details.Code === "NoSuchKey" || details.$metadata?.httpStatusCode === 404) {
        return null;
      }

      throw error;
    }
  }
}
