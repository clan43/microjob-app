import { Check } from "lucide-react";
import { CLOTHING_STYLES } from "@/app/ai-editor/_components/clothingStyles";
import { BulkT, useBulkPhotoText } from "./bulkPhotoI18n";
import type { BulkExtras } from "./types";

export const BG_SWATCHES: Array<{ name: string; hex: string }> = [
    { name: "White", hex: "#FFFFFF" },
    { name: "Light blue", hex: "#38BDF8" },
    { name: "Blue", hex: "#3B82F6" },
    { name: "Grey", hex: "#9CA3AF" },
    { name: "Teal", hex: "#0F766E" },
    { name: "Cream", hex: "#FEF3C7" },
];

export const OUTFIT_COLORS: Array<{ name: string; hex: string }> = [
    { name: "Black", hex: "#111827" },
    { name: "White", hex: "#FFFFFF" },
    { name: "Navy", hex: "#1E3A8A" },
    { name: "Grey", hex: "#6B7280" },
    { name: "Maroon", hex: "#7F1D1D" },
    { name: "Green", hex: "#166534" },
    { name: "Sky blue", hex: "#7DD3FC" },
    { name: "Beige", hex: "#D6C3A1" },
];

function Swatch({ hex, label, active, disabled, onClick }: { hex: string; label: string; active: boolean; disabled?: boolean; onClick: () => void }) {
    const light = hex.toUpperCase() === "#FFFFFF" || hex.toUpperCase() === "#FEF3C7";
    return (<button type="button" onClick={onClick} disabled={disabled} aria-pressed={active} aria-label={label} title={label} className={`flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border-2 transition duration-200 hover:scale-110 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#DC2626]/40 ${active ? "border-[#DC2626] ring-2 ring-[#DC2626]/30" : "border-[#D8C9A6]"}`} style={{ backgroundColor: hex }}>
      {active && <Check size={13} strokeWidth={3} className={light ? "text-[#DC2626]" : "text-white"}/>}
    </button>);
}

interface ToolExtrasProps {
    extras: BulkExtras;
    onChange: (next: BulkExtras) => void;
    disabled?: boolean;
}

/** Shown under "Photo Background" when "Background Replace" is ticked. */
export function BackgroundColorOptions({ extras, onChange, disabled = false }: ToolExtrasProps) {
    const { t } = useBulkPhotoText();
    const custom = extras.bgHex && !BG_SWATCHES.some((swatch) => swatch.hex.toUpperCase() === extras.bgHex.toUpperCase());
    return (<div className="border-t border-[#E3D6B8] bg-[#FBF6E8] px-3 py-2.5">
      <p className="text-[12.5px] font-bold text-[#3B2F1E]"><BulkT>{"Background colour"}</BulkT></p>
      <p className="text-[12px] leading-snug text-[#6B5A40]"><BulkT>{"Pick a solid colour, or leave it empty and let the AI choose."}</BulkT></p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {BG_SWATCHES.map((swatch) => (<Swatch key={swatch.hex} hex={swatch.hex} label={t(swatch.name)} disabled={disabled} active={extras.bgHex.toUpperCase() === swatch.hex.toUpperCase()} onClick={() => onChange({ ...extras, bgHex: extras.bgHex.toUpperCase() === swatch.hex.toUpperCase() ? "" : swatch.hex })}/>))}
        <label className={`relative flex h-7 cursor-pointer items-center gap-1 rounded-full border-2 bg-[#F6EEDB] px-2 text-[12px] font-bold text-[#5A4A32] transition hover:bg-[#EFE3C8] ${custom ? "border-[#DC2626] ring-2 ring-[#DC2626]/30" : "border-[#D8C9A6]"} ${disabled ? "cursor-not-allowed opacity-60" : ""}`}>
          <span className="h-3.5 w-3.5 rounded-full border border-[#D8C9A6]" style={{ backgroundColor: custom ? extras.bgHex : "#FFFFFF" }}/>
          <BulkT>{"Custom"}</BulkT>
          <input type="color" disabled={disabled} value={/^#[0-9A-F]{6}$/i.test(extras.bgHex) ? extras.bgHex : "#FFFFFF"} onChange={(event) => onChange({ ...extras, bgHex: event.target.value.toUpperCase() })} className="absolute inset-0 h-full w-full cursor-pointer opacity-0"/>
        </label>
        {extras.bgHex && (<button type="button" disabled={disabled} onClick={() => onChange({ ...extras, bgHex: "" })} className="cursor-pointer rounded-md px-1.5 py-0.5 text-[12px] font-semibold text-[#B91C1C] transition hover:bg-[#FEE9E9] disabled:cursor-not-allowed"><BulkT>{"Clear"}</BulkT></button>)}
      </div>
    </div>);
}

/** Shown under "Dress Style" when "Outfit Color Change" is ticked. */
export function OutfitOptions({ extras, onChange, disabled = false }: ToolExtrasProps) {
    const { t } = useBulkPhotoText();
    return (<div className="border-t border-[#E3D6B8] bg-[#FBF6E8] px-3 py-2.5">
      <p className="text-[12.5px] font-bold text-[#3B2F1E]"><BulkT>{"Outfit"}</BulkT></p>
      <p className="text-[12px] leading-snug text-[#6B5A40]"><BulkT>{"Choose a clothing style and its colour, or leave them empty to keep the outfit."}</BulkT></p>
      <select value={extras.outfitStyle} disabled={disabled} onChange={(event) => onChange({ ...extras, outfitStyle: event.target.value })} aria-label={t("Clothing style")} className="mt-2 w-full cursor-pointer rounded-lg border border-[#E3D6B8] bg-[#F6EEDB] px-2 py-1.5 text-[13px] font-semibold text-[#5A4A32] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#DC2626]/40 disabled:cursor-not-allowed disabled:opacity-60">
        <option value="">{t("Keep the current outfit style")}</option>
        {CLOTHING_STYLES.map((style) => (<option key={style.name} value={style.name}>{style.name}</option>))}
      </select>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {OUTFIT_COLORS.map((color) => (<Swatch key={color.name} hex={color.hex} label={t(color.name)} disabled={disabled} active={extras.outfitColor === color.name} onClick={() => onChange({ ...extras, outfitColor: extras.outfitColor === color.name ? "" : color.name })}/>))}
        {(extras.outfitColor || extras.outfitStyle) && (<button type="button" disabled={disabled} onClick={() => onChange({ ...extras, outfitStyle: "", outfitColor: "" })} className="cursor-pointer rounded-md px-1.5 py-0.5 text-[12px] font-semibold text-[#B91C1C] transition hover:bg-[#FEE9E9] disabled:cursor-not-allowed"><BulkT>{"Clear"}</BulkT></button>)}
      </div>
    </div>);
}
