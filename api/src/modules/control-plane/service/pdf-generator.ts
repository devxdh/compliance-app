import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { CertificateRow } from "../repository/types";

/**
 * Technical details included in the proof of erasure.
 */
export interface ProofOfErasureData {
  requestId: string;
  subjectOpaqueId: string;
  method: string;
  legalFramework: string;
  appliedRuleName: string | null;
  appliedRuleCitation: string | null;
  shreddedAt: string;
  finalWormHash: string | null;
  blobSummary?: {
    totalObjects: number;
    totalVersionsPurged: number;
    provider: string;
  };
  signature: {
    algorithm: string;
    keyId: string;
    signatureBase64: string;
    publicKeySpkiBase64: string;
  };
}

/**
 * Service for generating human-readable legal artifacts from raw ledger data.
 */
export class PdfCertificateGenerator {
  /**
   * Generates a digitally signed PDF "Certificate of Erasure".
   *
   * @param data - Normalized certificate and signature data.
   * @param clientDisplayName - Optional display name of the tenant authority.
   * @returns PDF buffer as Uint8Array.
   */
  async generate(data: ProofOfErasureData, clientDisplayName: string = "DPDP Authority"): Promise<Uint8Array> {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([600, 800]);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const courier = await pdfDoc.embedFont(StandardFonts.Courier);

    const { width, height } = page.getSize();
    const margin = 50;

    // Header
    page.drawText("CERTIFICATE OF PERMANENT DATA ERASURE", {
      x: margin,
      y: height - 100,
      size: 20,
      font: boldFont,
      color: rgb(0, 0, 0),
    });

    page.drawLine({
      start: { x: margin, y: height - 110 },
      end: { x: width - margin, y: height - 110 },
      thickness: 2,
      color: rgb(0, 0, 0),
    });

    // Subject Details
    let cursorY = height - 160;
    const drawField = (label: string, value: string | null) => {
      page.drawText(`${label}:`, { x: margin, y: cursorY, size: 10, font: boldFont });
      page.drawText(value ?? "N/A", { x: margin + 150, y: cursorY, size: 10, font });
      cursorY -= 25;
    };

    drawField("Authority", clientDisplayName);
    drawField("Request ID", data.requestId);
    drawField("Subject Identifier", data.subjectOpaqueId);
    drawField("Erasure Method", data.method);
    drawField("Completed At", data.shreddedAt);
    cursorY -= 10;

    // Legal Compliance Section
    page.drawText("LEGAL COMPLIANCE", { x: margin, y: cursorY, size: 12, font: boldFont });
    cursorY -= 15;
    page.drawLine({
      start: { x: margin, y: cursorY },
      end: { x: width - margin, y: cursorY },
      thickness: 1,
      color: rgb(0.8, 0.8, 0.8),
    });
    cursorY -= 20;

    drawField("Legal Framework", data.legalFramework);
    drawField("Rule Applied", data.appliedRuleName);
    drawField("Statutory Citation", data.appliedRuleCitation);
    cursorY -= 10;

    // Object Storage Section
    if (data.blobSummary && data.blobSummary.totalObjects > 0) {
      page.drawText("OBJECT STORAGE PURGE", { x: margin, y: cursorY, size: 12, font: boldFont });
      cursorY -= 15;
      page.drawLine({
        start: { x: margin, y: cursorY },
        end: { x: width - margin, y: cursorY },
        thickness: 1,
        color: rgb(0.8, 0.8, 0.8),
      });
      cursorY -= 20;

      drawField("Storage Provider", data.blobSummary.provider);
      drawField("Linked Objects Purged", String(data.blobSummary.totalObjects));
      drawField("Total Versions Deleted", String(data.blobSummary.totalVersionsPurged));
      cursorY -= 10;
    }

    // Cryptographic Proof Section
    page.drawText("CRYPTOGRAPHIC PROOF (WORM)", { x: margin, y: cursorY, size: 12, font: boldFont });
    cursorY -= 15;
    page.drawLine({
      start: { x: margin, y: cursorY },
      end: { x: width - margin, y: cursorY },
      thickness: 1,
      color: rgb(0.8, 0.8, 0.8),
    });
    cursorY -= 20;

    page.drawText("Final Ledger Hash (SHA-256):", { x: margin, y: cursorY, size: 10, font: boldFont });
    cursorY -= 15;
    page.drawText(data.finalWormHash ?? "GENESIS", {
      x: margin,
      y: cursorY,
      size: 9,
      font: courier,
      color: rgb(0.2, 0.2, 0.2),
    });
    cursorY -= 30;

    page.drawText("Digital Signature (Ed25519):", { x: margin, y: cursorY, size: 10, font: boldFont });
    cursorY -= 15;
    const signatureChunk = data.signature.signatureBase64.match(/.{1,64}/g) ?? [];
    for (const chunk of signatureChunk) {
      page.drawText(chunk, { x: margin, y: cursorY, size: 8, font: courier, color: rgb(0.3, 0.3, 0.3) });
      cursorY -= 12;
    }
    cursorY -= 10;

    page.drawText("Signing Key ID:", { x: margin, y: cursorY, size: 10, font: boldFont });
    page.drawText(data.signature.keyId, { x: margin + 150, y: cursorY, size: 9, font: courier });

    // Footer
    page.drawText("This document is a machine-generated legal record of non-reversible cryptographic erasure.", {
      x: margin,
      y: 40,
      size: 8,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });

    return pdfDoc.save();
  }
}
