// Editable personal notes below the immutable transaction and source details.
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ImagePlus, MessageSquareText, Paperclip, Trash2 } from "lucide-react";
import toast from "react-hot-toast";
import { apiGet, apiPutForm } from "../api.js";
import TransactionAttachmentViewer from "./TransactionAttachmentViewer.jsx";

const imageTypes = ["image/png", "image/jpeg", "image/webp"];
const draftKey = (notes, attachments) => JSON.stringify([notes, attachments.map((item) => [item.id || item.key, item.caption])]);

export function transactionHasNotes(transaction) {
  return Boolean(transaction?.notes?.trim() || Number(transaction?.attachment_count));
}

export function TransactionNotesIndicator({ transaction, onClick }) {
  if (transaction?.isForecastVirtual || !transactionHasNotes(transaction)) return null;
  const Icon = Number(transaction.attachment_count) ? Paperclip : MessageSquareText;
  return <button type="button" className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-blue-600 hover:bg-blue-50" title={transaction.notes?.trim() || "הערות וקבצים מצורפים"} aria-label="הערות וקבצים מצורפים" onClick={(event) => { event.stopPropagation(); onClick(); }}><Icon size={16} /></button>;
}

/** Own the unsaved draft, upload lifecycle, and discard protection for the dialog. */
const TransactionNotes = forwardRef(function TransactionNotes({ transactionId, focusNotes, onSaved, onClose }, ref) {
  const [saved, setSaved] = useState(null);
  const [notes, setNotes] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(null);
  const [discard, setDiscard] = useState(false);
  const [viewer, setViewer] = useState(null);
  const sectionRef = useRef(null);
  const textRef = useRef(null);
  const fileRef = useRef(null);
  const urls = useRef(new Set());
  const focused = useRef(false);
  const savingRef = useRef(false);
  const dirty = Boolean(saved && draftKey(notes, attachments) !== draftKey(saved.notes, saved.attachments));

  function releaseDraftImages() {
    urls.current.forEach((url) => URL.revokeObjectURL(url));
    urls.current.clear();
  }

  function adopt(result) {
    releaseDraftImages();
    const next = { ...result, attachments: result.attachments.map((item) => ({ ...item,
      url: `/api/transactions/${transactionId}/attachments/${item.id}`,
      downloadUrl: `/api/transactions/${transactionId}/attachments/${item.id}?download=1`,
    })) };
    setSaved(next); setNotes(next.notes); setAttachments(next.attachments);
    setConflict(null); setError(""); setViewer(null);
  }

  async function load() {
    setLoading(true); setError("");
    try { adopt(await apiGet(`/api/transactions/${transactionId}/notes`)); }
    catch { setError("לא ניתן לטעון את ההערות. נסה שוב."); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    let active = true;
    apiGet(`/api/transactions/${transactionId}/notes`)
      .then((result) => { if (active) adopt(result); })
      .catch(() => { if (active) setError("לא ניתן לטעון את ההערות. נסה שוב."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; releaseDraftImages(); };
  }, [transactionId]);

  useEffect(() => {
    if (!focusNotes || loading || !saved || focused.current) return;
    focused.current = true;
    const frame = requestAnimationFrame(() => {
      sectionRef.current?.scrollIntoView({ block: "start" });
      textRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusNotes, loading, saved]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useImperativeHandle(ref, () => ({ requestClose() {
    if (savingRef.current) return;
    if (viewer) { setViewer(null); return; }
    if (discard) { setDiscard(false); return; }
    if (dirty) setDiscard(true); else onClose();
  } }));

  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length || savingRef.current || !saved) return;
    if (attachments.length + files.length > 5) { setError("ניתן לצרף עד 5 תמונות לתנועה."); return; }
    if (files.some((file) => !imageTypes.includes(file.type) || !file.size || file.size > 10 * 1024 * 1024)) {
      setError("יש לבחור תמונות PNG, JPEG או WebP בגודל עד 10 MiB לתמונה."); return;
    }
    const added = files.map((file) => {
      const url = URL.createObjectURL(file); urls.current.add(url);
      return { key: crypto.randomUUID(), file, file_name: file.name, caption: "", url };
    });
    setAttachments((items) => [...items, ...added]); setError("");
  }

  function removeAttachment(item) {
    if (item.file) { URL.revokeObjectURL(item.url); urls.current.delete(item.url); }
    setAttachments((items) => items.filter((other) => other !== item));
  }

  async function save() {
    if (!saved || savingRef.current || !dirty) return;
    savingRef.current = true; setSaving(true); setError("");
    const fresh = attachments.filter((item) => item.file);
    const body = new FormData();
    body.append("draft", JSON.stringify({ notes, expected_revision: saved.revision,
      retained: attachments.filter((item) => item.id).map(({ id, caption }) => ({ id, caption })),
      captions: fresh.map((item) => item.caption),
    }));
    fresh.forEach((item) => body.append("files", item.file));
    try {
      const result = await apiPutForm(`/api/transactions/${transactionId}/notes`, body);
      adopt(result);
      toast.success("ההערות נשמרו.");
      try { await onSaved?.({ id: transactionId, notes: result.notes || null, notes_revision: result.revision, notes_updated_at: result.updated_at, attachment_count: result.attachments.length }); }
      catch { setError("ההערות נשמרו, אך רענון התנועות נכשל."); }
    } catch (failure) {
      if (failure.status === 409) {
        setError("ההערות עודכנו בחלון אחר. הטיוטה שלך לא נדרסה.");
        try { setConflict(await apiGet(`/api/transactions/${transactionId}/notes`)); } catch { /* Keep the draft if comparison cannot load. */ }
      } else if (failure.status === 413) setError("הקבצים חורגים ממגבלת ההעלאה.");
      else if (failure.status === 404) setError("התנועה או אחד הקבצים כבר אינם קיימים. הטיוטה נשארת זמינה.");
      else if (failure.code === "unsupported_image") setError("אחד הקבצים אינו תמונה נתמכת ותקינה.");
      else setError("שמירת ההערות נכשלה. הטיוטה נשארת זמינה לניסיון נוסף.");
    } finally { savingRef.current = false; setSaving(false); }
  }

  return (
    <section ref={sectionRef} className="mt-6 border-t border-slate-300 pt-5" dir="rtl" aria-label="הערות וקבצים מצורפים"
      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer.files); }}
      onPaste={(event) => {
        const files = Array.from(event.clipboardData.items || []).filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter(Boolean);
        if (files.length) { event.preventDefault(); addFiles(files); }
      }}>
      <h3 className="mb-3 text-sm font-semibold text-slate-800">הערות וקבצים מצורפים</h3>
      {loading && <p role="status" className="text-sm text-slate-500">טוענים הערות...</p>}
      {error && <p role="alert" className="mb-3 break-words text-sm text-red-700">{error}</p>}
      {!saved && !loading && <button type="button" className="btn" onClick={load}>נסה שוב</button>}
      {saved && <fieldset disabled={saving} className="min-w-0 space-y-3">
        <label className="block text-sm text-slate-700">הערה אישית
          <textarea ref={textRef} className="input mt-2 min-h-28 w-full resize-y whitespace-pre-wrap" rows={4} maxLength={10000} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
        <input ref={fileRef} type="file" className="hidden" multiple accept={imageTypes.join(",")} onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} />
        <button type="button" className="btn inline-flex items-center gap-2" disabled={attachments.length >= 5} onClick={() => fileRef.current?.click()}><ImagePlus size={18} />צרף תמונה</button>
        {attachments.length > 0 && <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {attachments.map((item) => <div key={item.id || item.key} className="min-w-0 rounded-lg border border-slate-200 p-2">
            <button type="button" className="block aspect-video w-full overflow-hidden rounded bg-slate-50" onClick={() => setViewer(item)} title="הגדל תמונה" aria-label="הגדל תמונה">
              <img src={item.url} alt={item.caption || item.file_name} className="h-full w-full object-contain" loading="lazy" />
            </button>
            <div className="mt-2 flex items-center justify-between gap-2"><span className="min-w-0 truncate text-xs text-slate-500" title={item.file_name}>{item.file_name}</span>
              <button type="button" className="btn shrink-0" title="הסר תמונה" aria-label={`הסר תמונה ${item.file_name}`} onClick={() => removeAttachment(item)}><Trash2 size={16} /></button>
            </div>
            <label className="mt-2 block text-xs text-slate-500">תיאור התמונה<input className="input mt-1 w-full" maxLength={1000} value={item.caption} onChange={(event) => setAttachments((items) => items.map((other) => other === item ? { ...other, caption: event.target.value } : other))} /></label>
          </div>)}
        </div>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" disabled={!dirty} onClick={() => adopt(saved)}>ביטול</button>
          <button type="button" className="btn" disabled={!dirty} onClick={save}>שמור</button>
        </div>
      </fieldset>}
      {conflict && <div className="mt-4 border-t border-slate-200 pt-3 text-sm">
        <h4 className="font-semibold">הגרסה השמורה העדכנית</h4>
        <p className="my-2 whitespace-pre-wrap break-words">{conflict.notes || "ללא הערה"}</p>
        {conflict.attachments.map((item) => <p key={item.id} className="break-words">{item.file_name}{item.caption ? `: ${item.caption}` : ""}</p>)}
        <button type="button" className="btn mt-2" onClick={() => adopt(conflict)}>החלף טיוטה בגרסה השמורה</button>
      </div>}
      {viewer && <TransactionAttachmentViewer key={viewer.id || viewer.key} attachment={viewer} onClose={() => setViewer(null)} />}
      {discard && <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/40 p-4" onClick={(event) => { event.stopPropagation(); setDiscard(false); }} role="alertdialog" aria-modal="true" aria-label="שינויים שלא נשמרו">
        <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
          <h3 className="text-lg font-semibold">שינויים שלא נשמרו</h3><p className="mt-2 text-sm text-slate-600">לסגור ללא שמירת ההערה והתמונות?</p>
          <div className="mt-5 flex justify-end gap-2"><button className="btn" type="button" autoFocus onClick={() => setDiscard(false)}>המשך עריכה</button><button className="btn" type="button" onClick={onClose}>סגור ללא שמירה</button></div>
        </div>
      </div>}
      {saving && <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/40 p-4" role="status" aria-live="polite" onClick={(event) => event.stopPropagation()}>
        <div className="rounded-xl border border-slate-200 bg-white px-6 py-5 text-center shadow-xl">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-slate-900" />
          <div className="mt-4 text-lg font-semibold text-slate-900">שומרים הערות וקבצים מצורפים</div>
          <div className="mt-1 text-sm text-slate-600">השינויים נשמרים כעת. בעוד רגע המסך יחזור להיות זמין.</div>
        </div>
      </div>}
    </section>
  );
});

export default TransactionNotes;
