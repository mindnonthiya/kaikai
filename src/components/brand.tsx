export function BrandIcon({ size = 38 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="brand-icon-svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="kk-bg" x1="4" y1="4" x2="44" y2="44" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FF7A3D" />
          <stop offset="55%" stopColor="#EA580C" />
          <stop offset="100%" stopColor="#C2410C" />
        </linearGradient>
        <linearGradient id="kk-comb" x1="16" y1="8" x2="32" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFE082" />
          <stop offset="100%" stopColor="#F59E0B" />
        </linearGradient>
        <linearGradient id="kk-beak" x1="28" y1="18" x2="38" y2="25" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FEF08A" />
          <stop offset="100%" stopColor="#FBBF24" />
        </linearGradient>
      </defs>
      {/* Premium Squircle Base */}
      <rect width="48" height="48" rx="14" fill="url(#kk-bg)" />
      <rect x="0.75" y="0.75" width="46.5" height="46.5" rx="13.25" stroke="white" strokeOpacity="0.28" strokeWidth="1.5" />

      {/* Golden Rooster Comb (หงอนไก่ทรงเปลวเพลิงสีทอง 3 แฉก) */}
      <path d="M17.5 17C16 11.5 20.5 9.5 22.5 13.5C23.5 7.5 28.5 8 29.5 14C30.5 10 34 11 34 16C34 17.5 32.5 18 31 18L18.5 18C17.5 18 17.5 17.5 17.5 17Z" fill="url(#kk-comb)" />

      {/* Golden Sharp Beak (จะงอยปากสีทอง) */}
      <path d="M30 20.5L37.5 23L30 25.8Z" fill="url(#kk-beak)" />

      {/* Sleek Chicken Head & Chest (โครงสร้างโมเดิร์นสีขาวสะอาด) */}
      <path d="M13 36C14 27.5 17.5 19 23 17.5C26 16.8 30.5 17 31 20C31.5 22.8 28.5 24.5 27 25.5C25.5 26.5 24 28 23 30.5C21.8 33.5 20.2 35.8 17 36.8C15.2 37.3 13.8 37 13 36Z" fill="white" />

      {/* Crimson Wattle (เหนียงใต้คางสีแดงสด) */}
      <path d="M28 25.5C29 26 30 27.5 29.5 29C29 30.2 27.5 30.5 26.8 29.5C26 28.5 26.5 26.5 28 25.5Z" fill="#DC2626" />

      {/* Eye with highlight */}
      <circle cx="26" cy="21.5" r="1.6" fill="#9A3412" />
      <circle cx="26.4" cy="21.1" r="0.5" fill="white" />

      {/* Upward Profit Arc / Wing (ปีกทะยานขึ้น สื่อถึงกำไรที่เติบโต) */}
      <path d="M19 33.5C23 31.5 27.5 29.5 34 29C35.5 28.9 36 29.8 35 30.8C31 34.5 25.5 36.8 19 36.8C18.2 36.8 18.2 34 19 33.5Z" fill="white" fillOpacity="0.92" />

      {/* Profit Sparkle Star (ประกายกำไร) */}
      <path d="M39 10L39.9 12.6L42.5 13.5L39.9 14.4L39 17L38.1 14.4L35.5 13.5L38.1 12.6Z" fill="#FEF08A" />
    </svg>
  );
}

export function Brand({ compact = false, className = "" }: { compact?: boolean; className?: string }) {
  return (
    <div className={`brand ${className}`.trim()} aria-label="kaikai">
      <BrandIcon size={compact ? 32 : 38} />
      {!compact && (
        <span className="brand-copy">
          <strong>
            kai<span className="brand-accent">kai</span>
          </strong>
          <small>รู้ทันทุน เห็นกำไร</small>
        </span>
      )}
    </div>
  );
}

