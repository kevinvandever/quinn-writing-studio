import { useState, useCallback, useRef, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { get } from '../../services/api-client';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// Types
interface CorpusDocument {
  id: string;
  sourceType: string;
  sourceId: string;
  title: string;
  wordCount: number;
  sortOrder: number;
  isFolder: boolean;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
  children: CorpusDocument[];
}

interface DocumentDetail {
  id: string;
  project_id: string;
  source_type: string;
  source_id: string;
  title: string;
  content: string;
  content_hash: string;
  word_count: number;
  is_folder: boolean;
}

interface ImportRecord {
  id: string;
  filename: string;
  document_count: number;
  total_word_count: number;
  parse_errors: Array<{ documentName: string; error: string }>;
  diff_summary: {
    added: Array<{ title: string; uuid: string }>;
    modified: Array<{ title: string; uuid: string; oldWordCount: number; newWordCount: number }>;
    deleted: Array<{ title: string; uuid: string }>;
  } | null;
  imported_at: string;
}

interface UploadResult {
  import: {
    id: string;
    filename: string;
    documentCount: number;
    totalWordCount: number;
    parseErrors: Array<{ documentName: string; error: string }>;
    diffSummary: ImportRecord['diff_summary'];
  };
}

export function CorpusBrowser() {
  const { id: projectId } = useParams<{ id: string }>();
  const [documents, setDocuments] = useState<CorpusDocument[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<DocumentDetail | null>(null);
  const [imports, setImports] = useState<ImportRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<UploadResult['import'] | null>(null);
  const [activeTab, setActiveTab] = useState<'tree' | 'history'>('tree');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load corpus tree and import history
  const loadData = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [treeData, importsData] = await Promise.all([
        get<{ documents: CorpusDocument[] }>(`/api/projects/${projectId}/corpus`),
        get<{ imports: ImportRecord[] }>(`/api/projects/${projectId}/corpus/imports`),
      ]);
      setDocuments(treeData.documents);
      setImports(importsData.imports);
    } catch (err) {
      console.error('Failed to load corpus data:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Handle file upload
  const handleUpload = async (file: File) => {
    if (!projectId) return;
    setUploading(true);
    setUploadResult(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch(
        `${BASE_URL}/api/projects/${projectId}/corpus/upload`,
        {
          method: 'POST',
          credentials: 'include',
          body: formData,
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Upload failed');
      }

      const result: UploadResult = await response.json();
      setUploadResult(result.import);
      await loadData();
    } catch (err) {
      console.error('Upload failed:', err);
      alert(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  // Handle document selection
  const handleSelectDocument = async (docId: string) => {
    try {
      const data = await get<{ document: DocumentDetail }>(`/api/corpus/documents/${docId}`);
      setSelectedDoc(data.document);
    } catch (err) {
      console.error('Failed to load document:', err);
    }
  };

  // Drag and drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => {
    setDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      handleUpload(file);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleUpload(file);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900">Corpus</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setActiveTab('tree')}
            className={`px-3 py-1.5 text-sm rounded-md ${
              activeTab === 'tree'
                ? 'bg-indigo-100 text-indigo-700 font-medium'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            Documents
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={`px-3 py-1.5 text-sm rounded-md ${
              activeTab === 'history'
                ? 'bg-indigo-100 text-indigo-700 font-medium'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            Import History
          </button>
        </div>
      </div>

      {/* Upload Zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
          dragOver
            ? 'border-indigo-400 bg-indigo-50'
            : 'border-gray-300 hover:border-gray-400'
        }`}
      >
        {uploading ? (
          <div className="flex items-center justify-center gap-2">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-indigo-600" />
            <span className="text-gray-600">Parsing Scrivener project...</span>
          </div>
        ) : (
          <>
            <p className="text-gray-600 mb-2">
              Drag and drop a .scriv ZIP file here, or{' '}
              <button
                onClick={() => fileInputRef.current?.click()}
                className="text-indigo-600 hover:text-indigo-700 font-medium"
              >
                browse
              </button>
            </p>
            <p className="text-xs text-gray-400">
              Supports .scriv packages exported as ZIP files (max 50MB)
            </p>
          </>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,.scriv"
          onChange={handleFileSelect}
          className="hidden"
          aria-label="Upload Scrivener file"
        />
      </div>

      {/* Upload Result */}
      {uploadResult && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <h3 className="font-medium text-green-800 mb-2">Import Successful</h3>
          <p className="text-sm text-green-700">
            Imported {uploadResult.documentCount} documents ({uploadResult.totalWordCount.toLocaleString()} words) from{' '}
            <span className="font-mono">{uploadResult.filename}</span>
          </p>
          {uploadResult.diffSummary && (
            <div className="mt-2 text-sm text-green-700">
              {uploadResult.diffSummary.added.length > 0 && (
                <span className="mr-3">+{uploadResult.diffSummary.added.length} added</span>
              )}
              {uploadResult.diffSummary.modified.length > 0 && (
                <span className="mr-3">~{uploadResult.diffSummary.modified.length} modified</span>
              )}
              {uploadResult.diffSummary.deleted.length > 0 && (
                <span>-{uploadResult.diffSummary.deleted.length} deleted</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Main Content */}
      {activeTab === 'tree' ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Document Tree */}
          <div className="lg:col-span-1 border border-gray-200 rounded-lg overflow-hidden">
            <div className="bg-gray-50 px-4 py-2 border-b border-gray-200">
              <h3 className="text-sm font-medium text-gray-700">Document Tree</h3>
            </div>
            <div className="p-2 max-h-[600px] overflow-y-auto">
              {documents.length === 0 ? (
                <p className="text-sm text-gray-500 p-4 text-center">
                  No documents yet. Upload a Scrivener project to get started.
                </p>
              ) : (
                <DocumentTree
                  documents={documents}
                  selectedId={selectedDoc?.id ?? null}
                  onSelect={handleSelectDocument}
                />
              )}
            </div>
          </div>

          {/* Document Viewer */}
          <div className="lg:col-span-2 border border-gray-200 rounded-lg overflow-hidden">
            <div className="bg-gray-50 px-4 py-2 border-b border-gray-200">
              <h3 className="text-sm font-medium text-gray-700">
                {selectedDoc ? selectedDoc.title : 'Select a document'}
              </h3>
              {selectedDoc && (
                <span className="text-xs text-gray-500">
                  {selectedDoc.word_count?.toLocaleString()} words
                </span>
              )}
            </div>
            <div className="p-4 max-h-[600px] overflow-y-auto">
              {selectedDoc ? (
                <pre className="whitespace-pre-wrap text-sm text-gray-800 font-serif leading-relaxed">
                  {selectedDoc.content || '(Empty document)'}
                </pre>
              ) : (
                <p className="text-sm text-gray-500 text-center py-8">
                  Click a document in the tree to view its content.
                </p>
              )}
            </div>
          </div>
        </div>
      ) : (
        <ImportHistory imports={imports} />
      )}
    </div>
  );
}

// Document Tree Component
function DocumentTree({
  documents,
  selectedId,
  onSelect,
}: {
  documents: CorpusDocument[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="space-y-0.5" role="tree">
      {documents.map((doc) => (
        <TreeNode
          key={doc.id}
          document={doc}
          selectedId={selectedId}
          onSelect={onSelect}
          depth={0}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  document,
  selectedId,
  onSelect,
  depth,
}: {
  document: CorpusDocument;
  selectedId: string | null;
  onSelect: (id: string) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const isSelected = document.id === selectedId;
  const hasChildren = document.children.length > 0;

  return (
    <li role="treeitem" aria-expanded={document.isFolder ? expanded : undefined}>
      <button
        onClick={() => {
          if (document.isFolder) {
            setExpanded(!expanded);
          } else {
            onSelect(document.id);
          }
        }}
        className={`w-full text-left px-2 py-1 rounded text-sm flex items-center gap-1.5 ${
          isSelected
            ? 'bg-indigo-100 text-indigo-800'
            : 'hover:bg-gray-100 text-gray-700'
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {document.isFolder ? (
          <span className="text-xs text-gray-400">
            {expanded ? '▼' : '▶'}
          </span>
        ) : (
          <span className="text-xs text-gray-300">•</span>
        )}
        <span className={document.isFolder ? 'font-medium' : ''}>
          {document.title}
        </span>
        {!document.isFolder && document.wordCount > 0 && (
          <span className="ml-auto text-xs text-gray-400">
            {document.wordCount.toLocaleString()}
          </span>
        )}
      </button>
      {document.isFolder && expanded && hasChildren && (
        <ul className="space-y-0.5" role="group">
          {document.children.map((child) => (
            <TreeNode
              key={child.id}
              document={child}
              selectedId={selectedId}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// Import History Component
function ImportHistory({ imports }: { imports: ImportRecord[] }) {
  if (imports.length === 0) {
    return (
      <p className="text-sm text-gray-500 text-center py-8">
        No import history yet.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {imports.map((imp) => (
        <div
          key={imp.id}
          className="border border-gray-200 rounded-lg p-4"
        >
          <div className="flex items-center justify-between mb-2">
            <h4 className="font-medium text-gray-900 text-sm font-mono">
              {imp.filename}
            </h4>
            <span className="text-xs text-gray-500">
              {new Date(imp.imported_at).toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>
          <div className="text-sm text-gray-600 mb-2">
            {imp.document_count} documents · {imp.total_word_count.toLocaleString()} words
          </div>
          {imp.diff_summary && (
            <div className="flex gap-3 text-xs">
              {imp.diff_summary.added.length > 0 && (
                <span className="text-green-600">
                  +{imp.diff_summary.added.length} added
                </span>
              )}
              {imp.diff_summary.modified.length > 0 && (
                <span className="text-amber-600">
                  ~{imp.diff_summary.modified.length} modified
                </span>
              )}
              {imp.diff_summary.deleted.length > 0 && (
                <span className="text-red-600">
                  -{imp.diff_summary.deleted.length} deleted
                </span>
              )}
            </div>
          )}
          {imp.parse_errors && imp.parse_errors.length > 0 && (
            <div className="mt-2 text-xs text-red-600">
              {imp.parse_errors.length} parse error(s)
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
