/**
 * Starter Overpass QL snippets, keyed to the atrocity-investigation domains.
 *
 * Each snippet's `ql` uses `{{bbox}}` so the backend substitutes the user's
 * selected region at run time. Snippets always include the `[out:json]` header
 * and `out body geom;` footer so they're runnable as-is.
 */

export interface Snippet {
  id: string;
  title: string;
  description: string;
  ql: string;
}

export const QUERY_SNIPPETS: Snippet[] = [
  {
    id: "detention-facilities",
    title: "Detention facilities",
    description:
      "Prisons and explicit detention buildings. Cross-reference with military landuse for unofficial sites.",
    ql: `[out:json][timeout:25];
(
  nwr["amenity"="prison"]({{bbox}});
  nwr["building"="prison"]({{bbox}});
);
out body geom;`,
  },
  {
    id: "schools-education",
    title: "Schools & education",
    description: "Schools, kindergartens, universities — civilian infrastructure at risk.",
    ql: `[out:json][timeout:25];
nwr["amenity"="school"]({{bbox}});
out body geom;`,
  },
  {
    id: "hospitals-clinics",
    title: "Hospitals & clinics",
    description: "Medical facilities — both amenity= and healthcare= tagging conventions.",
    ql: `[out:json][timeout:25];
(
  nwr["amenity"="hospital"]({{bbox}});
  nwr["amenity"="clinic"]({{bbox}});
  nwr["healthcare"~"hospital|clinic"]({{bbox}});
);
out body geom;`,
  },
  {
    id: "religious-sites",
    title: "Religious sites",
    description: "Places of worship across all denominations.",
    ql: `[out:json][timeout:25];
nwr["amenity"="place_of_worship"]({{bbox}});
out body geom;`,
  },
  {
    id: "cemeteries-graves",
    title: "Cemeteries & graves",
    description:
      "Cemeteries, grave yards, and explicitly-tagged mass-grave memorials.",
    ql: `[out:json][timeout:25];
(
  nwr["landuse"="cemetery"]({{bbox}});
  nwr["amenity"="grave_yard"]({{bbox}});
  nwr["historic"="memorial"]["memorial"="mass_grave"]({{bbox}});
);
out body geom;`,
  },
  {
    id: "military-installations",
    title: "Military installations",
    description: "Military landuse polygons plus any feature tagged with military=*.",
    ql: `[out:json][timeout:25];
(
  nwr["landuse"="military"]({{bbox}});
  nwr["military"]({{bbox}});
);
out body geom;`,
  },
  {
    id: "damaged-buildings",
    title: "Damaged buildings",
    description: "Buildings tagged as damaged or destroyed — cross-ref with 3D Tiles.",
    ql: `[out:json][timeout:25];
(
  nwr["damage"="destroyed"]({{bbox}});
  nwr["building:condition"~"damaged|destroyed"]({{bbox}});
);
out body geom;`,
  },
  {
    id: "custom",
    title: "Custom",
    description: "Empty scaffold with the Overpass header and footer in place.",
    ql: `[out:json][timeout:25];
// your query here
out body geom;`,
  },
];
