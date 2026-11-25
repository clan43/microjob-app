"use client";
import React, { useState } from "react";
import { Clock3, Heart, Search, SlidersHorizontal, TrendingUp, ArrowDownAZ, X, RotateCcw } from "lucide-react";
import { useAiTemplateText } from "./aiTemplateI18n";
import {
  AVAILABLE_GENDERS,
  AVAILABLE_ORIENTATIONS,
  CATEGORY_COUNTS,
  CATEGORY_OPTIONS,
  COLOR_OPTIONS,
  HASHTAGS,
  IMAGE_COUNT_OPTIONS,
} from "./templateData";
import type { ColorFilter, Gender, ImageCountFilter, OrientationFilter, SortType } from "./templateData";

type Props = {
  search: string;
  setSearch: (v: string) => void;
  sortType: SortType;
  setSortType: (v: SortType) => void;
  showFavorites: boolean;
  setShowFavorites: (v: boolean | ((prev: boolean) => boolean)) => void;
  favoritesCount: number;
  onHashtagClick: (tag: string) => void;
  filteredCount: number;
  category: string;
  setCategory: (v: string) => void;
  gender: Gender;
  setGender: (v: Gender) => void;
  imageCount: ImageCountFilter;
  setImageCount: (v: ImageCountFilter) => void;
  orientation: OrientationFilter;
  setOrientation: (v: OrientationFilter) => void;
  selectedColor: ColorFilter;
  setSelectedColor: (v: ColorFilter) => void;
  resetFilters: () => void;
};

export function TemplateToolbar(props: Props) {
  const {
    search, setSearch, sortType, setSortType, showFavorites, setShowFavorites, favoritesCount,
    onHashtagClick, filteredCount, category, setCategory, gender, setGender, imageCount, setImageCount,
    orientation, setOrientation, selectedColor, setSelectedColor, resetFilters,
  } = props;
  const { t, locale } = useAiTemplateText();
  const [panelOpen, setPanelOpen] = useState(false);

  const activeFilters =
    (gender !== "All" ? 1 : 0) +
    (imageCount !== "All" ? 1 : 0) +
    (orientation !== "All" ? 1 : 0) +
    (selectedColor !== "All" ? 1 : 0);
  const anythingActive = activeFilters > 0 || category !== "All" || search.trim() !== "" || showFavorites;
  const showOrientation = AVAILABLE_ORIENTATIONS.length > 1;
  const numberLocale = locale?.toLowerCase().startsWith("bn") ? "bn-BD" : "en-US";

  return (
    <section className="tp">
      {/* ---------- Title + sorting ---------- */}
      <header className="tp-head">
        <div className="tp-title">
          <h1>{t("AI Template")}</h1>
          <p>{t("Pick a style you like, upload your photo, and we'll generate the same look for you in seconds.")}</p>
        </div>

        <div className="tp-actions">
          <div className="tp-seg" role="group" aria-label={t("Sort")}>
            <button type="button" className={sortType === "Newest" ? "on" : ""} aria-pressed={sortType === "Newest"} onClick={() => setSortType("Newest")}>
              <Clock3 size={14} />{t("Newest first")}
            </button>
            <button type="button" className={sortType === "Popular" ? "on" : ""} aria-pressed={sortType === "Popular"} onClick={() => setSortType("Popular")}>
              <TrendingUp size={14} />{t("Popular")}
            </button>
            <button
              type="button"
              className={sortType === "ASC" || sortType === "DESC" ? "on" : ""}
              aria-pressed={sortType === "ASC" || sortType === "DESC"}
              onClick={() => setSortType(sortType === "ASC" ? "DESC" : "ASC")}
            >
              <ArrowDownAZ size={14} />{sortType === "DESC" ? t("DESC") : t("ASC")}
            </button>
          </div>

          <button type="button" className={`tp-fav ${showFavorites ? "on" : ""}`} aria-pressed={showFavorites} onClick={() => setShowFavorites((prev: boolean) => !prev)}>
            <Heart size={15} fill={showFavorites ? "currentColor" : "none"} />
            {t("My Favorites")}
            <span>{favoritesCount.toLocaleString(numberLocale)}</span>
          </button>
        </div>
      </header>

      {/* ---------- Categories ---------- */}
      <nav className="tp-cats" aria-label={t("CATEGORY")}>
        {CATEGORY_OPTIONS.map((item) => {
          const selected = category === item;
          return (
            <button type="button" key={item} className={selected ? "on" : ""} aria-pressed={selected} onClick={() => setCategory(item)}>
              {t(item)}
              <b>{(CATEGORY_COUNTS[item] || 0).toLocaleString(numberLocale)}</b>
            </button>
          );
        })}
      </nav>

      {/* ---------- Search + filters ---------- */}
      <div className="tp-searchrow">
        <div className="search-box">
          <Search size={17} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("Search by name or category...")} />
          {search && (
            <button type="button" onClick={() => setSearch("")} aria-label={t("Clear")}>
              <X size={15} />
            </button>
          )}
        </div>

        <button type="button" className={`tp-filter-btn ${panelOpen || activeFilters ? "on" : ""}`} aria-expanded={panelOpen} onClick={() => setPanelOpen((v) => !v)}>
          <SlidersHorizontal size={16} />
          {t("Filter")}
          {activeFilters > 0 && <span>{activeFilters.toLocaleString(numberLocale)}</span>}
        </button>
      </div>

      {panelOpen && (
        <div className="tp-panel">
          <div className="tp-group">
            <div className="tp-label">{t("GENDER")}</div>
            <div className="tp-chips">
              {(["All", ...AVAILABLE_GENDERS] as Gender[]).map((item) => (
                <button type="button" key={item} className={gender === item ? "on" : ""} aria-pressed={gender === item} onClick={() => setGender(item)}>
                  {t(item)}
                </button>
              ))}
            </div>
          </div>

          <div className="tp-group">
            <div className="tp-label">{t("IMAGE COUNT")}</div>
            <div className="tp-chips">
              {IMAGE_COUNT_OPTIONS.map(({ value, label }) => (
                <button type="button" key={label} className={imageCount === value ? "on" : ""} aria-pressed={imageCount === value} onClick={() => setImageCount(value)}>
                  {t(label)}
                </button>
              ))}
            </div>
          </div>

          {showOrientation && (
            <div className="tp-group">
              <div className="tp-label">{t("ORIENTATION")}</div>
              <div className="tp-chips">
                {(["All", ...AVAILABLE_ORIENTATIONS] as OrientationFilter[]).map((item) => (
                  <button type="button" key={item} className={orientation === item ? "on" : ""} aria-pressed={orientation === item} onClick={() => setOrientation(item)}>
                    {t(item)}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="tp-group">
            <div className="tp-label">{t("COLOR")}</div>
            <div className="tp-dots">
              {COLOR_OPTIONS.map(({ value, label, background }) => (
                <button
                  type="button"
                  key={value}
                  className={selectedColor === value ? "on" : ""}
                  onClick={() => setSelectedColor(value)}
                  aria-label={`${t("Color: ")}${t(label)}`}
                  aria-pressed={selectedColor === value}
                  title={t(label)}
                >
                  <i style={{ background }} />
                </button>
              ))}
            </div>
          </div>

          {activeFilters > 0 && (
            <button type="button" className="tp-clear" onClick={resetFilters}>
              <RotateCcw size={13} />{t("Reset")}
            </button>
          )}
        </div>
      )}

      {/* ---------- Hashtags ---------- */}
      {HASHTAGS.length > 0 && (
        <div className="tp-tags scroll">
          {HASHTAGS.map((tag) => (
            <button type="button" key={tag} onClick={() => onHashtagClick(tag)}>{t(tag)}</button>
          ))}
        </div>
      )}

      {/* ---------- Result line ---------- */}
      <div className="tp-result">
        <span>{filteredCount.toLocaleString(numberLocale)} {t("templates found")}</span>
        {anythingActive && (
          <button type="button" onClick={resetFilters}>
            <RotateCcw size={13} />{t("Reset")}
          </button>
        )}
      </div>
    </section>
  );
}
