import { useEffect, useState } from "react";
import { api } from "../lib/invoke";
import type { LookupItem } from "../types/database";

export interface Lookups {
  groups: LookupItem[];
  companies: LookupItem[];
  compositions: LookupItem[];
  taxPlans: LookupItem[];
  godowns: LookupItem[];
  packForms: LookupItem[];
  schedules: LookupItem[];
  series: LookupItem[];
}

const empty: Lookups = {
  groups: [],
  companies: [],
  compositions: [],
  taxPlans: [],
  godowns: [],
  packForms: [],
  schedules: [],
  series: [],
};

export function useLookups() {
  const [lookups, setLookups] = useState<Lookups>(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [groups, companies, compositions, taxPlans, godowns, packForms, schedules, series] =
          await Promise.all([
            api.listLookups("groups"),
            api.listLookups("companies"),
            api.listLookups("compositions"),
            api.listLookups("tax_plans"),
            api.listLookups("godowns"),
            api.listLookups("pack_forms"),
            api.listLookups("schedules"),
            api.listLookups("series"),
          ]);
        if (cancelled) return;
        setLookups({
          groups: groups.items,
          companies: companies.items,
          compositions: compositions.items,
          taxPlans: taxPlans.items,
          godowns: godowns.items,
          packForms: packForms.items,
          schedules: schedules.items,
          series: series.items,
        });
        setError(null);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Unable to load lookups");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return { lookups, loading, error };
}

export function taxBpsFromId(lookups: Lookups, taxId: string | null | undefined): number {
  if (!taxId) return 0;
  const plan = lookups.taxPlans.find((item) => item.id === taxId);
  return plan?.total_bps ?? 0;
}
