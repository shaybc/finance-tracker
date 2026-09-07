// Enlarged attachment viewing without disturbing the transaction note draft.
import React, { useState } from "react";
import { Download, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";

export default function TransactionAttachmentViewer({ attachment, onClose }) {
  const [zoom, setZoom] = useState(100);
  const [failed, setFailed] = useState(false);
  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-slate-950/90 p-4" role="dialog" aria-modal="true" aria-label={attachment.file_name} onClick={onClose}>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white p-3" onClick={(event) => event.stopPropagation()}>
        <div className="min-w-0 break-all text-sm">{attachment.caption || attachment.file_name}</div>
        <div className="flex items-center gap-2" dir="ltr">
          <button className="btn" type="button" title="הקטן" aria-label="הקטן" disabled={zoom <= 25} onClick={() => setZoom((value) => Math.max(25, value - 25))}><ZoomOut size={18} /></button>
          <span className="w-12 text-center text-sm">{zoom}%</span>
          <button className="btn" type="button" title="הגדל" aria-label="הגדל" disabled={zoom >= 400} onClick={() => setZoom((value) => Math.min(400, value + 25))}><ZoomIn size={18} /></button>
          <button className="btn" type="button" title="אפס זום" aria-label="אפס זום" onClick={() => setZoom(100)}><RotateCcw size={18} /></button>
          <a className="btn" href={attachment.downloadUrl || attachment.url} download={attachment.file_name} title="הורד תמונה" aria-label="הורד תמונה"><Download size={18} /></a>
          <button className="btn" type="button" title="סגור תמונה" aria-label="סגור תמונה" autoFocus onClick={onClose}><X size={18} /></button>
        </div>
      </div>
      <div className="mt-4 min-h-0 flex-1 overflow-auto" dir="ltr" onClick={(event) => event.stopPropagation()}>
        {failed ? <p className="text-center text-white" role="alert">לא ניתן להציג את התמונה.</p> : (
          <img src={attachment.url} alt={attachment.caption || attachment.file_name} onError={() => setFailed(true)} className="mx-auto block" style={{ width: `${zoom}%`, maxWidth: "none", objectFit: "contain" }} />
        )}
      </div>
    </div>
  );
}
