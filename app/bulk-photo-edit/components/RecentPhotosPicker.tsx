import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, ChevronUp, History, LoaderCircle } from "lucide-react";
import { blockImageMenu } from "@/app/_lib/imageProtect";
import { getAiEditorThumbnailUrl, getCachedAiEditorGenerations, refreshAiEditorGenerations, type AiEditorGeneration } from "@/app/ai-editor/_components/aiEditorData";
import { BulkT, useBulkPhotoText } from "./bulkPhotoI18n";

interface RecentPhotosPickerProps {
    onAddPhotos: (files: File[]) => void;
    /** How many more photos still fit in the batch. */
    slotsLeft: number;
    disabled?: boolean;
}

/** Lets the person reuse photos they made in the AI Editor, without uploading them again. */
export default function RecentPhotosPicker({ onAddPhotos, slotsLeft, disabled = false }: RecentPhotosPickerProps) {
    const { t } = useBulkPhotoText();
    const [open, setOpen] = useState(false);
    const [items, setItems] = useState<AiEditorGeneration[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [failed, setFailed] = useState(false);
    const [picked, setPicked] = useState<string[]>([]);
    const [adding, setAdding] = useState(false);

    useEffect(() => {
        if (disabled)
            setOpen(false);
    }, [disabled]);

    useEffect(() => {
        if (!open || items !== null)
            return;
        const cached = getCachedAiEditorGenerations();
        if (cached) {
            setItems(cached);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setFailed(false);
        refreshAiEditorGenerations()
            .then((list) => { if (!cancelled)
            setItems(list); })
            .catch(() => { if (!cancelled)
            setFailed(true); })
            .finally(() => { if (!cancelled)
            setLoading(false); });
        return () => { cancelled = true; };
    }, [open, items]);

    const toggle = (url: string) => {
        setPicked((current) => current.includes(url)
            ? current.filter((value) => value !== url)
            : current.length >= slotsLeft ? current : [...current, url]);
    };

    const addPicked = useCallback(async () => {
        if (!picked.length || adding)
            return;
        setAdding(true);
        try {
            const files: File[] = [];
            for (const [index, url] of picked.entries()) {
                const response = await fetch(url);
                if (!response.ok)
                    continue;
                const blob = await response.blob();
                const type = blob.type && blob.type.startsWith("image/") ? blob.type : "image/png";
                const extension = type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : "png";
                files.push(new File([blob], `recent-photo-${index + 1}.${extension}`, { type, lastModified: Date.now() }));
            }
            if (files.length) {
                onAddPhotos(files);
                setPicked([]);
                setOpen(false);
            }
        }
        catch {
            setFailed(true);
        }
        finally {
            setAdding(false);
        }
    }, [picked, adding, onAddPhotos]);

    const list = (items ?? []).filter((item) => item && typeof item.url === "string" && item.url);

    return (<div className="mt-2 shrink-0">
      <button type="button" onClick={() => setOpen((current) => !current)} disabled={disabled || slotsLeft <= 0} aria-expanded={open} className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl border border-[#E3D6B8] bg-[#FBF6E8] px-3 py-2 text-[14.5px] font-semibold text-[#5A4A32] shadow-sm transition duration-200 ease-out hover:border-[#DC2626]/40 hover:bg-[#EFE3C8] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#DC2626]/40">
        <span className="flex items-center gap-2"><History size={17} className="text-[#DC2626]"/><BulkT>{"Use recent photos"}</BulkT></span>
        {open ? <ChevronUp size={16}/> : <ChevronDown size={16}/>}
      </button>

      {open && (<div className="mt-2 rounded-xl border border-[#E3D6B8] bg-[#F6EEDB] p-2">
          {loading && (<p className="flex items-center justify-center gap-2 py-4 text-[13px] font-medium text-[#6B5A40]"><LoaderCircle size={15} className="animate-spin"/><BulkT>{"Loading your recent photos..."}</BulkT></p>)}
          {!loading && failed && (<p className="py-3 text-center text-[13px] font-medium text-[#B91C1C]"><BulkT>{"Recent photos could not be loaded. Please try again."}</BulkT></p>)}
          {!loading && !failed && items !== null && list.length === 0 && (<p className="py-3 text-center text-[13px] font-medium text-[#6B5A40]"><BulkT>{"No recent photos yet. Photos you make in the AI Editor will show up here."}</BulkT></p>)}
          {list.length > 0 && (<>
              <div className="scroll grid max-h-[210px] grid-cols-4 gap-1.5 overflow-y-auto pr-1">
                {list.map((item, index) => {
                    const url = String(item.url);
                    const on = picked.includes(url);
                    return (<button key={`${url}-${index}`} type="button" onClick={() => toggle(url)} aria-pressed={on} className={`relative aspect-square cursor-pointer overflow-hidden rounded-lg border-2 transition ${on ? "border-[#DC2626] ring-2 ring-[#DC2626]/30" : "border-[#E3D6B8] hover:border-[#DC2626]/50"}`}>
                      <img {...blockImageMenu} src={getAiEditorThumbnailUrl(url)} alt={t("Recent photo")} loading="lazy" draggable={false} className="h-full w-full object-cover"/>
                      {on && (<span className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-[#DC2626] text-white"><Check size={10} strokeWidth={3}/></span>)}
                    </button>);
                })}
              </div>
              <button type="button" onClick={() => { void addPicked(); }} disabled={picked.length === 0 || adding} className="mt-2 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-[#DC2626] px-3 py-1.5 text-[13.5px] font-bold text-white transition hover:bg-[#B91C1C] disabled:cursor-not-allowed disabled:opacity-50">
                {adding ? <LoaderCircle size={14} className="animate-spin"/> : null}
                <BulkT>{picked.length > 0 ? `Add ${picked.length} selected` : "Select photos to add"}</BulkT>
              </button>
            </>)}
        </div>)}
    </div>);
}
