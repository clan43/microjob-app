import { Ruler } from "lucide-react";
import { BulkT, useBulkPhotoText } from "./bulkPhotoI18n";
import { BULK_ADMISSION_OPTIONS, BULK_SIZE_OPTIONS, ORIGINAL_SIZE_ID, findSizeOption, type BulkOutputFormat } from "./bulkOutput";

interface OutputSizePickerProps {
    sizeId: string;
    onSizeChange: (id: string) => void;
    format: BulkOutputFormat;
    onFormatChange: (format: BulkOutputFormat) => void;
    disabled?: boolean;
}

/** "Photo size" step: pick an exact output size once, for every photo in the batch. */
export default function OutputSizePicker({ sizeId, onSizeChange, format, onFormatChange, disabled = false }: OutputSizePickerProps) {
    const { t } = useBulkPhotoText();
    const selected = findSizeOption(sizeId);
    const isAdmission = BULK_ADMISSION_OPTIONS.some((option) => option.id === sizeId);
    const sized = sizeId !== ORIGINAL_SIZE_ID;
    return (<div className="mb-2.5 rounded-xl border border-[#E3D6B8] bg-[#FBF6E8] p-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-wide text-[#6B5A40]">
          <Ruler size={13} className="text-[#DC2626]"/><BulkT>{"Photo size (optional)"}</BulkT>
        </p>
        {sized && (<span className="rounded-full bg-[#FEE9E9] px-2 py-0.5 text-[11.5px] font-bold text-[#B91C1C]">{selected.hint}</span>)}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {BULK_SIZE_OPTIONS.map((option) => {
            const active = option.id === sizeId;
            return (<button key={option.id} type="button" disabled={disabled} aria-pressed={active} onClick={() => onSizeChange(option.id)} title={option.value ? option.hint : t(option.hint)} className={`cursor-pointer rounded-lg border px-2.5 py-1 text-[13px] font-semibold transition duration-200 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#DC2626]/40 ${active
                ? "border-[#DC2626] bg-[#DC2626] text-white shadow-sm"
                : "border-[#E3D6B8] bg-[#F6EEDB] text-[#5A4A32] hover:border-[#DC2626]/40 hover:bg-[#EFE3C8]"}`}>
              <BulkT>{option.label}</BulkT>
            </button>);
        })}
      </div>

      <select value={isAdmission ? sizeId : ""} disabled={disabled} onChange={(event) => { if (event.target.value) onSizeChange(event.target.value); }} aria-label={t("University / job portal size")} className={`mt-1.5 w-full cursor-pointer rounded-lg border px-2 py-1.5 text-[13px] font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-[#DC2626]/40 disabled:cursor-not-allowed disabled:opacity-60 ${isAdmission ? "border-[#DC2626] bg-[#FEF1E0] text-[#B91C1C]" : "border-[#E3D6B8] bg-[#F6EEDB] text-[#5A4A32]"}`}>
        <option value="">{t("University / job portal size…")}</option>
        {BULK_ADMISSION_OPTIONS.map((option) => (<option key={option.id} value={option.id}>{option.label}</option>))}
      </select>

      {sized ? (<div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[12px] leading-snug text-[#6B5A40]"><BulkT>{"Every result is cropped to this size when you download or print."}</BulkT></p>
          <div role="radiogroup" aria-label={t("Download format")} className="flex shrink-0 gap-1 rounded-lg border border-[#E3D6B8] bg-[#F6EEDB] p-0.5">
            {(["jpg", "png"] as const).map((item) => (<button key={item} type="button" role="radio" aria-checked={format === item} disabled={disabled} onClick={() => onFormatChange(item)} className={`cursor-pointer rounded-md px-2 py-0.5 text-[12px] font-bold uppercase transition disabled:cursor-not-allowed ${format === item ? "bg-[#DC2626] text-white" : "text-[#5A4A32] hover:bg-[#EFE3C8]"}`}>{item}</button>))}
          </div>
        </div>) : (<p className="mt-2 text-[12px] leading-snug text-[#6B5A40]"><BulkT>{"Pick a size to get passport, visa or admission-ready photos in one go."}</BulkT></p>)}
    </div>);
}
