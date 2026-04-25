import type { BlobTarget } from "../../config/worker";
import type { S3Client } from "../../network/s3-client";

export type BlobAction = BlobTarget["action"];

export interface DiscoveredBlobObject {
  target: BlobTarget;
  sourceTable: string;
  sourceColumn: string;
  originalValue: string;
  maskedValue: string;
  bucket: string;
  key: string;
  versionId: string;
  eTag: string | null;
  overwriteETag: string | null;
  overwriteVersionId: string | null;
}

export interface BlobProtectionResult {
  sourceTable: string;
  sourceColumn: string;
  provider: "aws_s3";
  action: BlobAction;
  objectRefHash: string;
  versionIdHash: string;
  legalHoldApplied: boolean;
  overwriteApplied: boolean;
}

export interface BlobShredReceipt {
  provider: "aws_s3";
  action: BlobAction;
  objectRefHash: string;
  versionCount: number;
  deletedVersionIdHashes: string[];
  retainedVersionIdHashes: string[];
  status: "purged" | "captured_version_deleted" | "retained_by_policy";
}

export interface BlobWorkflowOptions {
  s3Client?: S3Client;
}
