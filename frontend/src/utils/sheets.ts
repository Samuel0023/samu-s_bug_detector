// Google Sheets CSV fetcher and parser
// 
// Expected Sheet format:
//   Column A: Categoría
//   Column B: Palabra
//
// How to publish:
//   1. Open your Google Sheet
//   2. File > Share > Publish to web
//   3. Select the sheet tab, format: CSV
//   4. Copy the URL and set it as VITE_SHEET_CSV_URL in .env

const SHEET_URL = import.meta.env.VITE_SHEET_CSV_URL || '';

export interface CategoryData {
  [category: string]: string[];
}

/**
 * Fetches a published Google Sheet CSV and parses it into a
 * { category: [word1, word2, ...] } structure.
 */
export async function fetchCategories(): Promise<CategoryData> {
  if (!SHEET_URL) {
    console.warn('[Sheets] No VITE_SHEET_CSV_URL set, using fallback categories');
    return getFallbackCategories();
  }

  try {
    const response = await fetch(SHEET_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const csv = await response.text();
    return parseCSV(csv);
  } catch (err) {
    console.error('[Sheets] Failed to fetch, using fallback:', err);
    return getFallbackCategories();
  }
}

/**
 * Parses CSV/TSV text into CategoryData.
 * Auto-detects delimiter (tab or comma).
 * Skips the header row. Expects: Category, Word
 */
function parseCSV(csv: string): CategoryData {
  const lines = csv.split('\n');
  const data: CategoryData = {};

  // Auto-detect delimiter: if first data line has a tab, it's TSV
  const delimiter = lines.length > 1 && lines[1].includes('\t') ? '\t' : ',';
  console.log(`[Sheets] Detected delimiter: ${delimiter === '\t' ? 'TAB' : 'COMMA'}, ${lines.length} lines`);

  for (let i = 1; i < lines.length; i++) { // skip header
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split(delimiter);
    if (parts.length >= 2) {
      // Strip quotes and trim
      const category = parts[0].replace(/^"|"$/g, '').trim();
      const word = parts[1].replace(/^"|"$/g, '').trim();
      if (category && word) {
        if (!data[category]) data[category] = [];
        data[category].push(word);
      }
    }
  }

  console.log(`[Sheets] Parsed ${Object.keys(data).length} categories:`, Object.keys(data));
  
  // If parsing returned nothing, use fallback
  if (Object.keys(data).length === 0) {
    console.warn('[Sheets] No categories parsed from sheet, using fallback');
    return getFallbackCategories();
  }

  return data;
}

/**
 * Fallback hardcoded categories in case Google Sheets is unavailable.
 */
function getFallbackCategories(): CategoryData {
  return {
    'Connect / Iglesia': [
      'Dani y Aldi', 'Bautismo', 'Alabanza', 'Versículo', 'Ayuno',
      'Célula', 'Púlpito', 'Misionero', 'Santa Cena', 'Campamento',
    ],
    'Mundo Dev': [
      'Git', 'Deploy', 'Bug', 'Sprint', 'API',
      'Frontend', 'Backend', 'Código', 'Pull Request', 'Docker',
    ],
    'Samu Personal': [
      'Asado', 'Fútbol', 'Gaming', 'Mate', 'Cumpleaños',
      'Música', 'Pizza', 'Netflix', 'Gym', 'Perro',
    ],
    'Cultura & Mix': [
      'Messi', 'Empanada', 'Tango', 'Instagram', 'Minecraft',
      'iPhone', 'Netflix', 'Spotify', 'Navidad', 'Playa',
    ],
  };
}
