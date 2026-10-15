'use client'

import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import styles from '@/app/page.module.css'
import { useCrm } from '@/components/crm/CrmContext'
import PageHeader from '@/components/crm/PageHeader'
import ImportChangePreview from '@/components/import/ImportChangePreview'
import ImportCommonTags from '@/components/import/ImportCommonTags'
import ImportMappingStatus from '@/components/import/ImportMappingStatus'
import ImportRequirements from '@/components/import/ImportRequirements'
import { useToast } from '@/components/ui/Toast'
import {
  analyseHeaders,
  emptyColumnMapping,
  isMappingComplete,
  type AmbiguousHeader,
  type ColumnMapping,
} from '@/lib/contacts/columnMapping'
import { getErrorMessage } from '@/lib/contacts/contactRows'
import { importContacts, previewContactImport } from '@/lib/contacts/import'
import { CRM_FIELDS } from '@/lib/contacts/importFields'
import { mapAndValidateRows } from '@/lib/excelParser'
import { VIEW_ROUTES } from '@/lib/navigation/routes'
import { getSupabaseClient } from '@/lib/supabaseClient'

type ParsedSpreadsheetResponse = { headers: string[]; rows: Record<string, string>[] }

/** The one-line and the full description of what an import did. */
export function describeImportResult(result: {
  inserted: number
  updated: number
  skipped: number
  duplicates?: number
  archived_collisions: number
}): { summary: string; detail: string } {
  const summary = [
    `${result.inserted} added`,
    `${result.updated} updated`,
    result.skipped > 0 ? `${result.skipped} skipped` : null,
    (result.duplicates ?? 0) > 0 ? `${result.duplicates} repeated in the file` : null,
    // Named rather than folded into "skipped": these rows were understood and deliberately
    // held back, and somebody has to go and look at them.
    result.archived_collisions > 0 ? `${result.archived_collisions} already archived` : null,
  ]
    .filter(Boolean)
    .join(', ')

  const detail =
    result.archived_collisions > 0
      ? `Import complete: ${summary}. ${result.archived_collisions} row(s) match a contact in the archive and were not imported — importing them would create a duplicate and restore email consent they had withdrawn. Restore them from Archive if they should come back.`
      : `Import complete: ${summary}.`

  return { summary, detail }
}

/**
 * The spreadsheet importer: upload, map columns, validate, preview what the database
 * would change (P3), commit. After a commit it opens Contacts, where the import's summary
 * stays on screen until dismissed.
 */
export default function ImportsView() {
  const router = useRouter()
  const { notify } = useToast()
  const { reloadLiveData, setImportSummary } = useCrm()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [importFile, setImportFile] = useState<{ name: string; size: number } | null>(null)
  const [importProgress, setImportProgress] = useState(0)
  const [isImporting, setIsImporting] = useState(false)
  const [isFileDragActive, setIsFileDragActive] = useState(false)
  const [isMapped, setIsMapped] = useState(false)
  const [rawHeaders, setRawHeaders] = useState<string[]>([])
  const [rawRows, setRawRows] = useState<Record<string, string>[]>([])
  const [showPreview, setShowPreview] = useState(false)
  const [columnMapping, setColumnMapping] = useState<ColumnMapping>(emptyColumnMapping())
  // Headers such as "Industry" that could mean more than one field; never auto-mapped.
  const [ambiguousHeaders, setAmbiguousHeaders] = useState<AmbiguousHeader[]>([])
  // Tags added to every accepted row, on top of each row's own Tags cell.
  const [commonTags, setCommonTags] = useState<string[]>([])

  const processImportFile = async (file: File) => {
    setImportFile({ name: file.name, size: file.size })
    setIsImporting(true)
    setImportProgress(0)
    setIsMapped(false)
    setShowPreview(false)
    setAmbiguousHeaders([])
    setCommonTags([])

    try {
      const formData = new FormData()
      formData.append('file', file)

      const res = await fetch('/api/import/parse', { method: 'POST', body: formData })
      setImportProgress(100)

      if (!res.ok) {
        const errData = await res.json()
        throw new Error(errData.error || 'Failed to parse file')
      }

      const data = (await res.json()) as ParsedSpreadsheetResponse
      setRawHeaders(data.headers)
      setRawRows(data.rows)

      // First guess only: the mapping screen below is where it gets confirmed.
      const { mapping, ambiguous } = analyseHeaders(data.headers)
      setColumnMapping(mapping)
      setAmbiguousHeaders(ambiguous)
      setIsMapped(true)
    } catch (err) {
      notify({ tone: 'error', message: `Could not read the spreadsheet: ${getErrorMessage(err)}` })
      setImportFile(null)
    } finally {
      setIsImporting(false)
    }
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) await processImportFile(file)
    e.target.value = ''
  }

  // Mapped once per mapping change, so the change preview is not re-requested on every
  // render. Common tags are part of the input: changing them yields a new previewImport,
  // which ImportChangePreview treats as "the import changed" and re-previews.
  const mappedImportRows = useMemo(
    () => mapAndValidateRows(rawRows, columnMapping, { commonTags }),
    [rawRows, columnMapping, commonTags]
  )

  /** What the import would change, computed by the database without writing (P3). */
  const previewImport = useCallback(
    () => previewContactImport(getSupabaseClient(), mappedImportRows),
    [mappedImportRows]
  )

  /**
   * Commits the import against the preview the operator just read. Errors are rethrown
   * for the preview panel, which keeps the upload and mapping in place.
   */
  const commitImport = useCallback(
    async (previewToken: string) => {
      const result = await importContacts(getSupabaseClient(), mappedImportRows, previewToken)
      await reloadLiveData()

      const { summary, detail } = describeImportResult(result)
      // A notice for the moment, and the full summary kept on Contacts until dismissed,
      // because it may name rows someone has to follow up.
      notify({ tone: result.archived_collisions > 0 ? 'info' : 'success', message: `Import complete: ${summary}.` })
      setImportSummary(detail)

      setImportFile(null)
      setRawHeaders([])
      setRawRows([])
      setShowPreview(false)
      setIsMapped(false)
      setAmbiguousHeaders([])
      setCommonTags([])
      router.push(VIEW_ROUTES.contacts)
    },
    [mappedImportRows, reloadLiveData, notify, setImportSummary, router]
  )

  return (
    <>
      <PageHeader
        eyebrow="Spreadsheet Tools"
        title="Spreadsheet importer"
        subtitle="Upload client list files to ingest data records into the database."
      />

      <div className={styles.splitLayout}>
        <div className={styles.sectionIntro} style={{ padding: '12px' }}>
          <h3 className={styles.sectionIntroTitle}>Data Ingestion Panel</h3>
          <p className={styles.sectionIntroDesc}>
            Upload spreadsheets (`.xls`, `.xlsx`, `.csv` or Apple `.numbers`) to import contact profiles, resolve company associations, and sync newsletter subscriptions.
          </p>
          <div className={styles.checklist}>
            <div className={styles.checklistItem}>
              <span className={styles.checkIcon}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </span>
              <span>Auto-creates Organisation profiles</span>
            </div>
            <div className={styles.checklistItem}>
              <span className={styles.checkIcon}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </span>
              <span>Identifies customer/prospect status</span>
            </div>
            <div className={styles.checklistItem}>
              <span className={styles.checkIcon}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </span>
              <span>Saves email list subscriptions</span>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {!importFile && !isImporting && (
            <div 
              className="outerShell"
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsFileDragActive(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
                setIsFileDragActive(true);
              }}
              onDragLeave={(event) => {
                if (event.currentTarget === event.target) setIsFileDragActive(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setIsFileDragActive(false);
                const file = event.dataTransfer.files?.[0];
                if (file) void processImportFile(file);
              }}
              role="button"
              tabIndex={0}
              aria-label="Choose or drop a spreadsheet file"
              data-drag-active={isFileDragActive ? 'true' : 'false'}
              style={{
                cursor: 'pointer',
                outline: isFileDragActive ? '2px solid var(--primary)' : undefined,
                outlineOffset: isFileDragActive ? '4px' : undefined,
              }}
            >
              <input 
                data-testid="excel-file-input"
                type="file" 
                ref={fileInputRef} 
                style={{ display: 'none' }} 
                accept=".xlsx,.xlsm,.xls,.csv,.tsv,.numbers"
                onChange={handleFileChange} 
              />
              <div className="innerCore" style={{ padding: '48px 24px' }}>
                <div className={styles.dropzoneInner} style={{ background: 'transparent', padding: 0 }}>
                  <div className={styles.uploadIconSpot}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                  </div>
                  <h4 style={{ color: 'var(--text-primary)', marginBottom: '6px', fontSize: '1rem', fontWeight: 600 }}>Drag and drop a spreadsheet here</h4>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>Excel (.xls, .xlsx), CSV or Apple Numbers (.numbers)</span>
                </div>
              </div>
            </div>
          )}

          {!importFile && !isImporting && <ImportRequirements label="Which columns do I need?" />}

          {isImporting && (
            <div className="outerShell">
              <div className="innerCore" style={{ padding: '32px 24px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
                  <div className={styles.uploadIconSpot} style={{ animation: 'pulseDot 1.5s infinite alternate' }}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                  </div>
                  <h4 style={{ color: 'var(--text-primary)', fontSize: '1.05rem', fontWeight: 600 }}>Uploading {importFile?.name}...</h4>
                  <div style={{ width: '100%', height: '8px', background: 'rgba(0,0,0,0.06)', borderRadius: '4px', overflow: 'hidden' }}>
                    <div style={{ width: `${importProgress}%`, height: '100%', background: 'var(--primary)', transition: 'width 100ms ease-out' }} />
                  </div>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{importProgress}% completed</span>
                </div>
              </div>
            </div>
          )}

          {isMapped && !showPreview && importFile && (
            <div className="outerShell">
              <div className="innerCore" style={{ padding: '24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', borderBottom: '1px dashed var(--border)', paddingBottom: '12px' }}>
                  <div>
                    <h4 style={{ color: 'var(--text-primary)', fontSize: '1.05rem', fontWeight: 600 }}>File Uploaded: {importFile.name}</h4>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.78rem' }}>Map spreadsheet columns to CRM field items.</span>
                    <ImportRequirements />
                  </div>
                  <button 
                    style={{ fontSize: '0.8rem', color: 'var(--danger)', fontWeight: 600, border: 'none', background: 'none', cursor: 'pointer' }}
                    onClick={() => {
                      setImportFile(null);
                      setIsMapped(false);
                      setAmbiguousHeaders([]);
                      setCommonTags([]);
                    }}
                  >
                    Reset File
                  </button>
                </div>

                <ImportMappingStatus
                  mapping={columnMapping}
                  ambiguous={ambiguousHeaders}
                  onMapColumn={(field, header) =>
                    setColumnMapping((prev) => ({ ...prev, [field]: header }))
                  }
                />

                <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '20px' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      <th style={{ textAlign: 'left', padding: '8px 12px', fontSize: '0.72rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>CRM field</th>
                      <th style={{ textAlign: 'left', padding: '8px 12px', fontSize: '0.72rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Spreadsheet column</th>
                    </tr>
                  </thead>
                  <tbody>
                    {CRM_FIELDS.map((field) => (
                      <tr key={field.key} style={{ borderBottom: '1px solid rgba(34, 38, 43, 0.05)' }}>
                        <td style={{ padding: '12px' }}>
                          <div style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                            {field.label}
                            {field.requirement && (
                              <span className={styles.requirementBadge}>{field.requirement}</span>
                            )}
                          </div>
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{field.description}</div>
                        </td>
                        <td style={{ padding: '12px' }}>
                          <select 
                            data-testid={`mapping-select-${field.key}`}
                            aria-label={`Spreadsheet column for ${field.label}`}
                            className={styles.searchInput} 
                            style={{ padding: '6px 12px', fontSize: '0.82rem', maxWidth: '240px' }} 
                            value={columnMapping[field.key] || ''}
                            onChange={(e) => {
                              setColumnMapping(prev => ({
                                ...prev,
                                [field.key]: e.target.value
                              }));
                            }}
                          >
                            <option value="">(Don&apos;t map this field)</option>
                            {rawHeaders.map((h) => (
                              <option key={h} value={h}>{h}</option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <ImportCommonTags value={commonTags} onChange={setCommonTags} />

                <button 
                  className={styles.actionButton} 
                  style={{ width: '100%', justifyContent: 'center' }}
                  disabled={!isMappingComplete(columnMapping)}
                  onClick={() => setShowPreview(true)}
                >
                  Preview Validation
                </button>
              </div>
            </div>
          )}

          {isMapped && showPreview && importFile && (
            <div className="outerShell">
              <div className="innerCore" style={{ padding: '24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', borderBottom: '1px dashed var(--border)', paddingBottom: '12px' }}>
                  <div>
                    <h4 style={{ color: 'var(--text-primary)', fontSize: '1.05rem', fontWeight: 600 }}>Validation Summary</h4>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.78rem' }}>Check valid and invalid records before importing.</span>
                  </div>
                  <button 
                    style={{ fontSize: '0.8rem', color: 'var(--primary)', fontWeight: 600, border: 'none', background: 'none', cursor: 'pointer' }}
                    onClick={() => setShowPreview(false)}
                  >
                    Back to Mapping
                  </button>
                </div>

                {(() => {
                  const mapped = mappedImportRows;
                  const validRows = mapped.filter(r => r.isValid);
                  const invalidRows = mapped.filter(r => !r.isValid);

                  return (
                    <div>
                      <div style={{ display: 'flex', gap: '16px', marginBottom: '20px' }}>
                        <div style={{ flex: 1, padding: '12px', background: 'rgba(1, 172, 219, 0.05)', borderRadius: '8px', border: '1px solid var(--glass-border)' }}>
                          <span style={{ fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>Total Rows</span>
                          <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>{mapped.length}</div>
                        </div>
                        <div style={{ flex: 1, padding: '12px', background: 'rgba(40, 167, 69, 0.05)', borderRadius: '8px', border: '1px solid rgba(40, 167, 69, 0.2)' }}>
                          <span style={{ fontSize: '0.72rem', textTransform: 'uppercase', color: 'rgba(40, 167, 69, 0.8)' }}>Valid Rows</span>
                          <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#28a745' }}>{validRows.length}</div>
                        </div>
                        <div style={{ flex: 1, padding: '12px', background: 'rgba(220, 53, 69, 0.05)', borderRadius: '8px', border: '1px solid rgba(220, 53, 69, 0.2)' }}>
                          <span style={{ fontSize: '0.72rem', textTransform: 'uppercase', color: 'rgba(220, 53, 69, 0.8)' }}>Invalid Rows</span>
                          <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#dc3545' }}>{invalidRows.length}</div>
                        </div>
                      </div>

                      <h5 style={{ color: 'var(--text-primary)', marginBottom: '8px', fontWeight: 600 }}>Valid Contacts ({validRows.length})</h5>
                      <div style={{ maxHeight: '180px', overflowY: 'auto', marginBottom: '20px', border: '1px solid var(--border)', borderRadius: '8px' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <tbody>
                            {validRows.length === 0 ? (
                              <tr><td style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>No valid rows.</td></tr>
                            ) : (
                              validRows.map((r, i) => (
                                <tr key={i} style={{ borderBottom: '1px solid rgba(0,0,0,0.05)' }}>
                                  <td style={{ padding: '8px 12px', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                    {r.data?.firstName} {r.data?.lastName}
                                  </td>
                                  <td style={{ padding: '8px 12px', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{r.data?.email}</td>
                                  <td style={{ padding: '8px 12px', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{r.data?.organisationName || '-'}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>

                      <h5 style={{ color: 'var(--text-primary)', marginBottom: '8px', fontWeight: 600 }}>Invalid Contacts ({invalidRows.length})</h5>
                      <div style={{ maxHeight: '180px', overflowY: 'auto', marginBottom: '20px', border: '1px solid var(--border)', borderRadius: '8px' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <tbody>
                            {invalidRows.length === 0 ? (
                              <tr><td style={{ padding: '12px', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>No invalid rows.</td></tr>
                            ) : (
                              invalidRows.map((r, i) => (
                                <tr key={i} style={{ borderBottom: '1px solid rgba(0,0,0,0.05)' }}>
                                  <td style={{ padding: '8px 12px', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                    Record #{i + 1}
                                  </td>
                                  <td style={{ padding: '8px 12px', fontSize: '0.82rem', color: 'var(--danger)', fontWeight: 500 }}>
                                    {r.errors?.join(', ')}
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>

                      {validRows.length > 0 ? (
                        <ImportChangePreview
                          rows={mapped}
                          onPreview={previewImport}
                          onCommit={commitImport}
                        />
                      ) : (
                        <p className={styles.settingDescription}>No valid rows to import.</p>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
