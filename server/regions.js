// Rough player region from the browser's time zone (e.g. "America/Chicago").
// Used only for the admin page, to see where a second game server would help.
// No IP lookups: the time zone is something the browser shares anyway.

export const REGIONS = ['Europe', 'US East / Central', 'US West', 'South America', 'Africa', 'Middle East', 'Asia', 'Oceania', 'Unknown'];

const US_WEST = new Set([
  'Los_Angeles', 'Vancouver', 'Tijuana', 'Denver', 'Phoenix', 'Boise', 'Edmonton', 'Anchorage', 'Juneau', 'Sitka',
  'Nome', 'Yakutat', 'Metlakatla', 'Hermosillo', 'Mazatlan', 'Chihuahua', 'Ciudad_Juarez', 'Ojinaga', 'Whitehorse',
  'Dawson', 'Dawson_Creek', 'Creston', 'Fort_Nelson', 'Yellowknife', 'Inuvik', 'Cambridge_Bay', 'Ensenada', 'Santa_Isabel',
]);
const SOUTH = new Set([
  'Sao_Paulo', 'Buenos_Aires', 'Santiago', 'Lima', 'Bogota', 'Caracas', 'Montevideo', 'Asuncion', 'La_Paz', 'Guayaquil',
  'Recife', 'Fortaleza', 'Bahia', 'Belem', 'Manaus', 'Cuiaba', 'Campo_Grande', 'Porto_Velho', 'Rio_Branco', 'Maceio',
  'Araguaina', 'Santarem', 'Boa_Vista', 'Noronha', 'Paramaribo', 'Cayenne', 'Guyana', 'Punta_Arenas', 'Eirunepe',
  'Cordoba', 'Mendoza', 'Rosario', 'Catamarca', 'Jujuy',
]);
const MIDDLE_EAST = new Set([
  'Dubai', 'Riyadh', 'Qatar', 'Bahrain', 'Kuwait', 'Muscat', 'Baghdad', 'Tehran', 'Jerusalem', 'Tel_Aviv', 'Beirut',
  'Damascus', 'Amman', 'Aden', 'Gaza', 'Hebron', 'Nicosia', 'Famagusta',
]);

export function regionOf(tz) {
  if (typeof tz !== 'string' || tz.length > 60) return 'Unknown';
  const [area, ...rest] = tz.split('/');
  const city = rest[rest.length - 1] || '';
  switch (area) {
    case 'Europe': return MIDDLE_EAST.has(city) ? 'Middle East' : 'Europe';
    case 'Atlantic': return city === 'Bermuda' ? 'US East / Central' : city === 'Stanley' || city === 'South_Georgia' ? 'South America' : 'Europe';
    case 'Africa': return city === 'Cairo' ? 'Middle East' : 'Africa';
    case 'America': return rest[0] === 'Argentina' || SOUTH.has(city) ? 'South America' : US_WEST.has(city) ? 'US West' : 'US East / Central';
    case 'US': case 'Canada': return /Pacific|Mountain|Alaska|Arizona|Hawaii|Yukon/.test(city) ? 'US West' : 'US East / Central';
    case 'Pacific': return city === 'Honolulu' ? 'US West' : 'Oceania';
    case 'Australia': return 'Oceania';
    case 'Asia': return MIDDLE_EAST.has(city) ? 'Middle East' : 'Asia';
    case 'Indian': return 'Asia';
    default: return 'Unknown';
  }
}
