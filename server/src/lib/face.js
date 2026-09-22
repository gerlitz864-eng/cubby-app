import crypto from 'node:crypto';

// Face verification is a plug-in. Implement this interface for a real provider:
//   verify({ staffId, templateRef, imageBase64 }) -> { result, score, liveness }
//       result is one of: 'verified' | 'failed' | 'low_confidence' | 'liveness_failed' | 'not_attempted'
//   enroll({ staffId, imageBase64 })   -> { templateRef, vendor, algorithmVersion }
//   deleteTemplate(templateRef)        -> void
//
// The 'mock' provider below is for DEMOS ONLY. It does not recognize anyone: it accepts any image unless the request
// says otherwise. Never use it with real staff. Templates must live in a separate encrypted store or a vetted vendor.
export function createFaceProvider(config) {
  if (config.faceProvider === 'mock') {
    return {
      name: 'mock (DEMO ONLY: identifies nobody)',
      async verify({ imageBase64, demoResult }) {
        if (!imageBase64 && !demoResult) return { result: 'not_attempted', score: null, liveness: null };
        if (demoResult === 'fail') return { result: 'failed', score: 0.31, liveness: true };
        if (demoResult === 'spoof') return { result: 'liveness_failed', score: 0.95, liveness: false };
        return { result: 'verified', score: 0.97, liveness: true };
      },
      async enroll({ staffId, imageBase64 }) {
        const ref = 'mock:' + crypto.createHash('sha256').update(String(staffId) + String(imageBase64 || '').slice(0, 64)).digest('hex').slice(0, 24);
        return { templateRef: ref, vendor: 'mock', algorithmVersion: 'demo-0' };
      },
      async deleteTemplate() { /* nothing stored */ }
    };
  }
  throw new Error(`Unknown FACE_PROVIDER "${config.faceProvider}". Implement the interface in lib/face.js.`);
}
