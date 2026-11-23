import { useCallback, useRef, useState } from "react";
import { ChevronsLeftRight } from "lucide-react";
import { blockImageMenu } from "@/app/_lib/imageProtect";
import { BulkT } from "./bulkPhotoI18n";

interface BeforeAfterSliderProps {
    beforeSrc: string;
    afterSrc: string;
    alt: string;
}

/** Drag the handle to compare the original (left) with the AI result (right). */
export default function BeforeAfterSlider({ beforeSrc, afterSrc, alt }: BeforeAfterSliderProps) {
    const boxRef = useRef<HTMLDivElement | null>(null);
    const [position, setPosition] = useState<number>(50);
    const dragging = useRef<boolean>(false);

    const moveTo = useCallback((clientX: number) => {
        const box = boxRef.current;
        if (!box)
            return;
        const rect = box.getBoundingClientRect();
        if (rect.width <= 0)
            return;
        setPosition(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)));
    }, []);

    return (<div ref={boxRef} role="slider" tabIndex={0} aria-label={alt} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(position)} onPointerDown={(event) => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); moveTo(event.clientX); }} onPointerMove={(event) => { if (dragging.current) moveTo(event.clientX); }} onPointerUp={(event) => { dragging.current = false; if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { dragging.current = false; }} onKeyDown={(event) => {
            if (event.key === "ArrowLeft")
                setPosition((current) => Math.max(0, current - 5));
            if (event.key === "ArrowRight")
                setPosition((current) => Math.min(100, current + 5));
        }} className="absolute inset-0 cursor-ew-resize touch-none select-none overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#DC2626]">
      {/* AI result sits underneath; the original is revealed on the left of the handle. */}
      <img {...blockImageMenu} src={afterSrc} alt={alt} draggable={false} className="absolute inset-0 h-full w-full object-cover"/>
      <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}>
        <img {...blockImageMenu} src={beforeSrc} alt="" draggable={false} className="h-full w-full object-cover"/>
      </div>

      <span className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-[#3B2F1E]/80 px-2.5 py-1 text-[12px] font-bold text-white"><BulkT>{"Original"}</BulkT></span>
      <span className="pointer-events-none absolute bottom-2 right-2 rounded-full bg-emerald-600/95 px-2.5 py-1 text-[12px] font-bold text-white"><BulkT>{"AI Result"}</BulkT></span>

      <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow-[0_0_6px_rgba(0,0,0,0.5)]" style={{ left: `${position}%` }}>
        <span className="absolute left-1/2 top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-[#DC2626] shadow-lg ring-2 ring-[#DC2626]/30">
          <ChevronsLeftRight size={18}/>
        </span>
      </div>
    </div>);
}
