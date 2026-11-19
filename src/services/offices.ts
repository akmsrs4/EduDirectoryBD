import { getCachedMeta, setCachedMeta } from '../lib/indexeddb';
import { getSupabaseClient, isSupabaseConfigured } from '../lib/supabase';
import type {
  EducationOffice,
  EducationOfficeFilterParams,
  EducationOfficeType,
} from '../types/institution';
import {
  REGIONAL_EDUCATION_OFFICES,
  mapDistrictOfficesCsv,
  mapUpazilaOfficesCsv,
} from '../utils/officeParser';

const BOOK1_CSV_PATH = '/assets/aistudio/Book1_26c72781.csv';
const BOOK2_CSV_PATH = '/assets/aistudio/Book2_52e85d2c.csv';
const CACHE_KEY = 'education_offices_v2';

let memoryOfficesCache: EducationOffice[] | null = null;
let memoryOfficesPromise: Promise<EducationOffice[]> | null = null;

const OFFICE_TYPE_RANK: Record<EducationOfficeType, number> = {
  regional: 0,
  district: 1,
  upazila: 2,
};

export function sortOfficesPriority(list: EducationOffice[]): EducationOffice[] {
  return [...list].sort((a, b) => {
    const rankDiff =
      (OFFICE_TYPE_RANK[a.office_type] ?? 9) - (OFFICE_TYPE_RANK[b.office_type] ?? 9);
    if (rankDiff !== 0) return rankDiff;
    return (a.serial_no ?? 999) - (b.serial_no ?? 999);
  });
}

export async function loadBundledCsvOffices(): Promise<EducationOffice[]> {
  if (memoryOfficesCache) return memoryOfficesCache;
  if (!memoryOfficesPromise) {
    memoryOfficesPromise = (async () => {
      const [res1, res2] = await Promise.all([fetch(BOOK1_CSV_PATH), fetch(BOOK2_CSV_PATH)]);
      if (!res1.ok || !res2.ok) {
        throw new Error('শিক্ষা অফিসের ডাটা ফাইল লোড করা যায়নি।');
      }
      const [text1, text2] = await Promise.all([res1.text(), res2.text()]);
      const combined = sortOfficesPriority([
        ...REGIONAL_EDUCATION_OFFICES,
        ...mapDistrictOfficesCsv(text1),
        ...mapUpazilaOfficesCsv(text2),
      ]);
      memoryOfficesCache = combined;
      await setCachedMeta(CACHE_KEY, combined);
      return combined;
    })();
  }
  return memoryOfficesPromise;
}

export function filterOfficesLocally(
  all: EducationOffice[],
  params: EducationOfficeFilterParams
): EducationOffice[] {
  const q = (params.search ?? '').trim().toLowerCase();

  const filtered = all.filter((o) => {
    if (!params.include_inactive && !o.is_active) return false;
    if (params.district && o.district !== params.district) return false;
    if (params.upazila) {
      if ((o.upazila ?? '') !== params.upazila) return false;
    }
    if (params.office_type && o.office_type !== params.office_type) return false;
    if (q) {
      const haystack = [
        o.office_name,
        o.district,
        o.upazila ?? '',
        o.officer_name ?? '',
        o.officer_designation ?? '',
        o.phone_raw ?? '',
        o.mobile_raw ?? '',
        o.email ?? '',
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  return sortOfficesPriority(filtered);
}

export async function fetchAllEducationOffices(
  includeInactive = false
): Promise<{ offices: EducationOffice[]; source: 'supabase' | 'offline_cache' | 'csv_seed' }> {
  const supabase = getSupabaseClient();

  if (supabase && (typeof navigator === 'undefined' || navigator.onLine)) {
    try {
      let query = supabase
        .from('education_offices')
        .select('*')
        .order('serial_no', { ascending: true });

      if (!includeInactive) {
        query = query.eq('is_active', true);
      }

      const { data, error } = await query;
      if (!error && data && data.length > 0) {
        const dbOffices = data as EducationOffice[];
        const hasRegional = dbOffices.some((o) => o.office_type === 'regional');
        const combined = sortOfficesPriority(
          hasRegional ? dbOffices : [...REGIONAL_EDUCATION_OFFICES, ...dbOffices]
        );
        await setCachedMeta(CACHE_KEY, combined);
        return { offices: combined, source: 'supabase' };
      }
    } catch {
      // Fall back cleanly if table hasn't been migrated yet or offline
    }
  }

  if (isSupabaseConfigured()) {
    const cached = await getCachedMeta<EducationOffice[]>(CACHE_KEY);
    if (cached && cached.value.length > 0) {
      return { offices: sortOfficesPriority(cached.value), source: 'offline_cache' };
    }
  }

  const seeded = await loadBundledCsvOffices();
  return { offices: seeded, source: 'csv_seed' };
}

export async function updateEducationOfficeAdmin(
  id: string,
  payload: Partial<EducationOffice>
): Promise<EducationOffice> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase সংযুক্ত নয়।');

  const { data, error } = await supabase
    .from('education_offices')
    .update(payload)
    .eq('id', id)
    .select('*')
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new Error(
      'এই অফিসের রেকর্ডটি এখনো Supabase ডাটাবেজে পাওয়া যায়নি। অনুগ্রহ করে প্রদত্ত SQL কোডটি Supabase SQL Editor-এ Run করুন।'
    );
  }

  memoryOfficesCache = null;
  memoryOfficesPromise = null;

  const updated = data as EducationOffice;
  const cached = await getCachedMeta<EducationOffice[]>(CACHE_KEY);
  if (cached?.value) {
    const nextList = cached.value.map((item) => (item.id === updated.id ? updated : item));
    await setCachedMeta(CACHE_KEY, sortOfficesPriority(nextList));
  }

  return updated;
}

export async function createEducationOfficeAdmin(
  payload: Omit<EducationOffice, 'id' | 'created_at' | 'updated_at'>
): Promise<EducationOffice> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase সংযুক্ত নয়।');

  const { data, error } = await supabase
    .from('education_offices')
    .insert(payload)
    .select('*')
    .single();
  if (error) throw error;

  memoryOfficesCache = null;
  memoryOfficesPromise = null;
  return data as EducationOffice;
}
