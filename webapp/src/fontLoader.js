// Dynamic Google Font loader — loads fonts on demand instead of all at once
// Maps font setting keys to Google Fonts family names
// Fonts not in this map are system/local fonts (georgia, consolas, cascadiacode)
const GOOGLE_FONT_MAP = {
    inter: 'Inter', roboto: 'Roboto', opensans: 'Open+Sans', lato: 'Lato',
    poppins: 'Poppins', nunito: 'Nunito', sourcesans: 'Source+Sans+3',
    dmsans: 'DM+Sans', worksans: 'Work+Sans', plusjakarta: 'Plus+Jakarta+Sans',
    lexend: 'Lexend', outfit: 'Outfit', spacegrotesk: 'Space+Grotesk',
    ibmplex: 'IBM+Plex+Sans', manrope: 'Manrope', urbanist: 'Urbanist',
    sora: 'Sora', atkinson: 'Atkinson+Hyperlegible+Next',
    figtree: 'Figtree', onest: 'Onest', rubik: 'Rubik',
    quicksand: 'Quicksand', comfortaa: 'Comfortaa', overpass: 'Overpass',
    karla: 'Karla', assistant: 'Assistant', exo2: 'Exo+2', barlow: 'Barlow',
    publicsans: 'Public+Sans', redhatdisplay: 'Red+Hat+Display', readexpro: 'Readex+Pro',
    merriweather: 'Merriweather', playfair: 'Playfair+Display',
    crimsonpro: 'Crimson+Pro', librebaskerville: 'Libre+Baskerville',
    lora: 'Lora', sourceserpro: 'Source+Serif+4',
    jetbrains: 'JetBrains+Mono', firacode: 'Fira+Code',
    spacemono: 'Space+Mono', ubuntumono: 'Ubuntu+Mono',
    anonymouspro: 'Anonymous+Pro', victormono: 'Victor+Mono',
    sourcecodepro: 'Source+Code+Pro', intelone: 'Intel+One+Mono',
    inconsolata: 'Inconsolata', martianmono: 'Martian+Mono',
    geist: 'Geist', geistmono: 'Geist+Mono',
};

const loadedFonts = new Set();

// Load a single Google Font by its setting key
export function loadGoogleFont(fontKey) {
    if (!fontKey || fontKey === 'system' || loadedFonts.has(fontKey)) return;
    const family = GOOGLE_FONT_MAP[fontKey];
    if (!family) return;
    loadedFonts.add(fontKey);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${family}:wght@300;400;500;600;700&display=swap`;
    document.head.appendChild(link);
}

// Batch-load multiple fonts (e.g., when opening the font picker dropdown)
export function loadGoogleFonts(fontKeys) {
    const toLoad = fontKeys.filter(k => k && k !== 'system' && !loadedFonts.has(k) && GOOGLE_FONT_MAP[k]);
    if (toLoad.length === 0) return;

    // Google Fonts supports multiple families in one request
    const families = toLoad.map(k => {
        loadedFonts.add(k);
        return `family=${GOOGLE_FONT_MAP[k]}:wght@400;500;600`;
    });

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?${families.join('&')}&display=swap`;
    document.head.appendChild(link);
}
