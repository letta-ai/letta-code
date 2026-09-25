/**
 * Exact historical Letta Code default prompts that Cloud agents may still have
 * stored explicitly. These are SHA-256 hashes of the trimmed files at the
 * indicated letta-code commits. Never match a prefix or edited prompt here:
 * an SDK caller's custom system prompt must remain theirs.
 *
 * Cloud-capable variants: letta.md, letta_root_memfs.md, letta_no_memfs.md.
 * Before March 2026, the default used system_prompt.txt alone or composed
 * it with system_prompt_memfs.txt / system_prompt_memory.txt. Those digests
 * hash `${base.trimEnd()}\n\n${addon.trimStart()}`.trim().
 * The local-only variant is deliberately excluded.
 */
export const LEGACY_CLOUD_DEFAULT_PROMPT_HASHES: ReadonlySet<string> = new Set([
  // src/agent/prompts/letta.md
  "sha256:m-96mEJhYbL5ahBr4Ey7U3XoezbGZdzo55aHFrToLG8", // fe944c0da6
  "sha256:jL1vX1J03wI9g53HlTY9tLxaFg1J_r3T_THQuf3_MgA", // 549edb9d93
  "sha256:Pb91lQ2PBESuJ-8YPwhVaDxLGXBUIKMqrLLv_OazHCc", // 1379be7c68
  "sha256:eKVlmYmQn3BwWwGArvltcgXx3cuNqfXeWmwfrRxEu5s", // 3d45a4f68b
  "sha256:Cxf5DBwsNCFnsnfTPgGlRoVDkHeMIylCQganTr7uMsI", // 2d99c28a63
  "sha256:2dnvyuoEjgObOCDpbJhL72aNu6JvM0bd7EKkRLiQrcA", // 258c8298e3
  "sha256:c1-eHU2G6oLBQeSvIn64t5_f79-eNq5KRr2xE5vTdK8", // c9c32a1f19
  "sha256:2wfqEEXfZ_Wo_pl-EL47_KdjUGIxqy7VIZyyn82JUBo", // 5234181e05
  "sha256:0MEm9fv2vEAJst6kbt1jM4DlFoamuR7ecVUPpVaj44w", // 08c511233f
  "sha256:iX-NMASdIF8dALlRjpY13hZTNuLTOEBxyhc_VXeU2WY", // 3dd0d85d11
  "sha256:vKnHYFPJv3t6cOx1-tqcVVSYlSZ14iKE-E-Jw77Bqiw", // 50a9e49eab
  "sha256:g173hXk2xGStktaU_MmXUhZYcN6OdLKHZzP2_OvqOls", // 71d42a3832
  "sha256:KyRKtLWUwifDcNmcawJdxBuvbHdobJdTUQhR5pFTpT0", // b43e22a8da
  "sha256:9cFUEsVo2UPPDUlQqUixmfd9MRgHoXE1J-V5exGtOYs", // 99bc341bf9
  "sha256:3hnrChMRXPxPz4HbkSbJ-Nznc_pYkoFZoTGP4c-6t5c", // 95dd86f73d
  "sha256:nA1zWGsWwC564p3gL8Wtmx-Ydmydf-IDaqtJgOHUZpo", // de124fd2a1
  "sha256:0LrWoEdI_THMac_zpl2AcGxhtZzk_Z0sNhAYqptB_q8", // c9899e5a84
  "sha256:gTwC-i17Pv4mh8QQDlHvNgbSadT-R7FqVqB0Gw0aP5A", // 4f851eff54
  "sha256:Rai4Ljr3MzRNuXbVzU9Leu68cSgQvmbjm7cQXABd_NQ", // 85cf2df141
  "sha256:8eGhK1107305b0Pe9yo-2a8HB4SMw16Fii_xx-IDDjY", // 959dfe0428
  "sha256:js3Atj5DqZGmw7o8fSRB-rWuV_dmBWkFAukSSDvEYPs", // 238af7dfb8
  "sha256:JBfQwoChYOOvn9YcLexA1L_FS_93Cu7rOEINW_WxxQg", // 591e6638cc
  // src/agent/prompts/letta_root_memfs.md
  "sha256:KsvfxD5Dr1CJgOeErsLVoDTz1TyGn8CevvpaIiYOuEU", // fe944c0da6
  "sha256:AgAAsq7Bjne9HgOAFzsyrcxc9ktTPsPdJrzekeObZaY", // 549edb9d93
  "sha256:NQ1OWIRC2u5-AWY7V11uUkjiJThNlwpEurNdM5TedbE", // 1379be7c68
  "sha256:a_8exdaG3Ql8eaMNGjewYL5czfop49JQjvXZhMDnEss", // 3d45a4f68b
  "sha256:uhsqMRXJdwKtsYSCl1rsXN7jBgzRIsgrpaty534bPFU", // 2d99c28a63
  "sha256:UqJ4nBKPbkraJNKCATbgpkChGrx-fwBlrMrQ_YJod-k", // 258c8298e3
  "sha256:pP52Xfl_z0AVOvz511aAQXeePAVYaN51bBu-_ylUlYI", // c9c32a1f19
  "sha256:1wFuhfHAY6IIymrj4Ai51ererXAFIUarK20u_gRreEE", // 5168bd600a
  // src/agent/prompts/letta_no_memfs.md
  "sha256:nS8fw6xbTyGH7myNqqgxfrDhtRp242ck0r2J2LyFSmM", // fe944c0da6
  "sha256:msmki1kfc5Bz3GZIo8v_SPfUTHbpjJqbiimR2QWrsZ4", // 549edb9d93
  "sha256:q16JqbqYOfBLMaA9hJDbj4y2kqYzxX9JRRJ7gvx50-Y", // 1379be7c68
  "sha256:whPN5eHvQ14X7SaGIMo3OZxzrfLyRgJ34DTEl-GpHVs", // 3d45a4f68b
  "sha256:sTl4GBjra4S_w6MfybaofewakSTC5GCzX4vzDWCpIRw", // 2d99c28a63
  "sha256:OeQZpy34Y573zlnzHyZnM6Is4w_1WH5Vlix267tgvD8", // 258c8298e3
  "sha256:mH037wy0GoQZ1Ft7iG73cXJLLJ7ONQVimGfcpWRs3d0", // 5234181e05
  "sha256:qcyBoIYquJ8G6JM1_5EOXC4QO8WamH8uBIO6D9c-6Ug", // 08c511233f
  "sha256:u6Zmcz42WWOeaRryhnIhDpm9sctc8NZgI5r9kwXm6vU", // c9899e5a84
  "sha256:uyjm_knWL1g9lABVWwBHKIOil5QBYbYZjlOvxaado-k", // 959dfe0428
  // Earlier default (raw, MemFS addon, or memory addon at each commit)
  "sha256:PIBHy9ZQ0uDZsg8-fjz13IRKUYdGaIU27bM_PfbRJ1M", // e82a2d33f8 raw
  "sha256:x9ASbPb1uPO8A43PG5OdIXh7dBm3TxKm1phpLYkqms0", // e82a2d33f8 memfs
  "sha256:ayGez5l2awOW28JAmq_oux5PBVcCdyFFQVWj5pn9vws", // e82a2d33f8 memory
  "sha256:EyOsxZd4JQqWYjExgAs3vyOLJnLBjH9QhIpzLhIS7Hg", // ab9a814e39 raw
  "sha256:29iThnse66CaEYKYPakQ_nntWYXG1HJ2iL_eSRKhPq8", // ab9a814e39 memfs
  "sha256:6uVru1Ya03yf6BzadYnoeheQameKQL-nTzp1NyTldXg", // ab9a814e39 memory
  "sha256:X7q6uKpOtHdPO9d92iUSES5qLdjUf328tIjbb2FRmu4", // 4cd1c5e22e memfs
  "sha256:5RpboxH-7RCQ08AIOpgHYcTjXfnkZg8umE79Jx6Cnjg", // 4cd1c5e22e memory
  "sha256:qtZ6XNh5d7iDautHQYddtGOUaIvuvuPZFzUQXV8QOeg", // 66ced52c81 raw
  "sha256:gr9y6OaAnRTSAW-DalWEk3NSGdBe-foq5pir0QL2XSg", // 66ced52c81 memfs
  "sha256:ia7tq6ObdaZPzmGiGNpz7DwvEk2aI_XvlT2ruk7V19M", // 66ced52c81 memory
  "sha256:E1XATa_rnOm72jRQieHwEcEtXkqaAT_-yuGsyqeK9lQ", // bf272ef009 memfs
  "sha256:Yc5KRrt4BAUnufqXQHueeHZRUEjHSdX36ns-haEbzR4", // bf272ef009 memory
  "sha256:H3U0hZG2AFHjPH2i7fvNOOnlF86PfuQ2bxGp1V84xeI", // d1a6eeb40a raw
  "sha256:9TxY5Jj2duyJRx6bp4MJ_K1-ANhdJyWnqSKCXdyC8Sc", // d1a6eeb40a memfs
  "sha256:aUpMugRTb3fBCytY7vt_1640-7IfugSZFAKut5t7dPA", // d2252e4834 memfs
  "sha256:BKFfn3X0Q_nyAw9QhBcfTLkGUclUfoKYRJ33cps-vaM", // 39d6537b7f raw
  "sha256:t8zBhWIHJIfZ2r7xTD7BXDLZ5Hk20ZtBQbWhUDW2X48", // 39d6537b7f memfs
  "sha256:XrR9ejZHzip34Lqa5UpQUo23EbKj-vFlAmLqOcsHL8Y", // 6a7d069fe5 memfs
  "sha256:3_j4K6e5HmSpxUugJIWDsB1HFdSxI3BTZWeNLwT4B9I", // 375e485874 raw
  "sha256:Z7J54-jRigKmCtTSf2o6DSu019c3wwd2uB1D-e_WcFQ", // 375e485874 memfs
  "sha256:6CmZBLYOAYXT3xk05HaoqpxBMYDqZuMLEjj38fhcs1Q", // 5e64033505 memfs
  "sha256:SvDN7a2kZvxggdQrWCmSyXL6S33gGOVbz0xo4p3CySw", // 654e492479 memfs
  "sha256:a6t8FhmYTdUgYkqBdoEY0XrL64mycRTRWMXwXHyjPHo", // 7ab97e404d memfs
  "sha256:3FfY_9sn1EBLGI0jcjKbtUTa7GKyQ-P6CxkyUdD2GdQ", // 8b3523c1a3 raw
  "sha256:V4ylYZi0hUVkaXH3qY0UKNwg8_QzRf0ezKjOHR7fhLM", // dc58439c84 raw
  "sha256:ludSKdS9_bNL9Um9q7uyxyfo2-FX-LdhhIZjS0foQ-E", // ea313159ce raw
  "sha256:ehxeKIRh8Pv_-FG07T8WWtRYka1B_vAZyX3PohhRmDw", // 70ac76040d raw
]);
