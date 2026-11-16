import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Aperture, ArrowDownToLine, ArrowLeftRight, Blend, Brush, ChevronDown, ChevronRight, Circle, Crop, Eraser, Eye, EyeOff, FileImage, FolderOpen, FolderPlus, Hand, ImagePlus, Layers, LockKeyhole, LockKeyholeOpen, Minus, MousePointer2, PaintBucket, Paintbrush, Plus, Redo2, RotateCcw, Search, Settings2, Shapes, SlidersHorizontal, Sparkles, Square, Type, Undo2, WandSparkles, X, Copy, ArrowUp, ArrowDown, Pencil, UnfoldHorizontal, Lasso, LassoSelect, ScanLine, Columns3, Check, Minus as MinusIcon, Expand, Shrink, RotateCcw as ResetIcon } from 'lucide-react';
import { DEFAULT_ADJUSTMENTS, duplicateLayer as duplicateLayerModel, estimateHistoryBytes, groupLayers, historyCanRedo, historyCanUndo, historyStateId, isHistoryDirty, makeCanvas, makeDocument, makeLayer, markDocumentSaved, pushHistory, reorderLayer, snapshotDocument, trimHistory, ungroupLayer, type ChannelView, type DocumentHistory, type DocumentModel, type DocumentSnapshot, type HistoryEntry, type LayerModel, type PixelTile, type SelectionKind, type SelectionState, type TextLayerData, type ShapeLayerData, type ShapeKind as VectorShapeKind, type VectorPath } from './editor-model';
import { DEFAULT_BRUSH_SETTINGS, drawBrushDot, drawBrushSegment, forEachBrushStamp, smoothBrushPoint, type BrushEngineSettings, type BrushPoint, type BrushSpacingState } from './brush-engine';
import { drawShapeContent, drawTextContent, drawVectorLayer, drawLayerThumbnail } from './vector-engine';
import { deserializeNativeProject, parseNativeProjectBytes, serializeNativeProject, type NativeProjectPackage } from './project-format';
import { colorSelection, combineSelection, featherSelection, invertSelection, marchingAntsPath, maskAlphaAt, modifySelection, rasterizeSelection, selectAll as makeSelectAll, translateSelection, cropSelection, mapSelection, type SelectionMode, type SelectionPoint, type ShapeKind } from './selection-engine';
import { appendSubpathsToPath, createVectorPath, deleteVectorPath, mapVectorPaths, renameVectorPath, selectionToSubpaths, setVectorPathVisibility, shapeLayerToSubpaths, supportsPathFromLayer } from './path-engine';
import { createChannelPreview } from './channel-engine';
import { duplicateLayerTree, mergeLayerSelection, moveLayer } from './editor-model';
import { documentToMaskPoint, invertMaskPixels, maskBrushStyle, maskToDocumentPoint, selectionMaskPixels } from './mask-engine';
import { applyAdjustmentLayerPixels, applyEffectStack, createEffect, effectName, effectParameterSpecs, type AdjustmentBlendMode, type EffectKind, type LayerEffect } from './adjustment-engine';
import { assertCanvasDimensions, inspectImageBlob, MAX_DOCUMENT_DIMENSION, MAX_MASK_ALPHA_CACHE_BYTES, MAX_PROJECT_FILE_BYTES } from './resource-limits';
import { BoundedSurfaceCache, canCompositeRegion, unionDirtyRect } from './render-cache';
import { applyFloodFillPixels, applyGradientPixels, floodFillPixels, type FillBlendMode, type GradientKind, type GradientStop } from './fill-engine';
import { applyRetouchStamp, createTiledPixelSampler, mapRetouchSourcePoint, type RetouchBuffer, type RetouchKind, type RetouchPoint } from './retouch-engine';
import './fill-tools.css';
import { applyHistoryPixelTiles } from './editor-model';
declare global { interface Window { pixelForge?: { openImage:()=>Promise<{path:string,data:string}|null>, openProject:()=>Promise<NativeProjectPackage|null>, readDroppedProject:(file:File)=>Promise<NativeProjectPackage|null>, saveProject:(request:{suggestedName:string;existingPath?:string;saveAs?:boolean;manifest:unknown;assets:Array<{id:string;mimeType:string;data:Uint8Array}>})=>Promise<{path:string}|null>, onCloseRequested:(callback:()=>void)=>()=>void, allowClose:()=>Promise<boolean>, cancelClose:()=>Promise<boolean>, readDroppedImage:(file:File)=>Promise<{name:string,mimeType:string,data:string}|null>, saveImage:(options:{suggestedName:string,data:string})=>Promise<string|null>, readPreferences:()=>Promise<Record<string,unknown>>, writePreferences:(prefs:Record<string,unknown>)=>Promise<boolean> } } }

type Layer=LayerModel;
type Tool='crop'|'move'|'brush'|'eraser'|'mask'|'clone'|'healing'|'marquee'|'ellipseSelect'|'rowSelect'|'columnSelect'|'lasso'|'polygonLasso'|'wand'|'gradient'|'fill'|'rectangle'|'roundedRectangle'|'ellipse'|'line'|'polygon'|'star'|'text'|'hand';
type RetouchSourceMode='active'|'merged';
type RetouchTarget='pixels'|'mask';
type RetouchStroke={
 kind:RetouchKind;sourceMode:RetouchSourceMode;sourceCanvas:HTMLCanvasElement;sourcePoint:RetouchPoint;targetAnchor:RetouchPoint;
 offset:RetouchPoint;target:RetouchTarget;mergedTiles:Map<string,ImageData>;layer:Layer
};
const mkCanvas=makeCanvas;
type BrushPreset={id:string;name:string;settings:BrushEngineSettings;custom?:boolean};
const STARTER_BRUSHES:BrushPreset[]=[{id:'hard-round',name:'Hard round',settings:{...DEFAULT_BRUSH_SETTINGS,hardness:100,spacing:10,tip:'round'}},{id:'soft-round',name:'Soft round',settings:{...DEFAULT_BRUSH_SETTINGS,hardness:0,spacing:12,tip:'soft'}},{id:'pencil',name:'Basic pencil',settings:{...DEFAULT_BRUSH_SETTINGS,hardness:100,opacity:100,flow:100,spacing:8,tip:'pencil'}},{id:'fine-detail',name:'Fine detail',settings:{...DEFAULT_BRUSH_SETTINGS,size:4,hardness:100,spacing:8,smoothing:10,tip:'round'}},{id:'large-soft',name:'Large soft brush',settings:{...DEFAULT_BRUSH_SETTINGS,size:120,hardness:0,opacity:65,flow:55,spacing:10,tip:'soft'}},{id:'texture',name:'Texture brush',settings:{...DEFAULT_BRUSH_SETTINGS,hardness:75,opacity:82,flow:72,spacing:24,tip:'texture'}}];
const brushReadContext=(canvas:HTMLCanvasElement)=>canvas.getContext('2d',{willReadFrequently:true})!;

export default function App(){
 const initialDocument=useRef<DocumentModel|null>(null);if(!initialDocument.current)initialDocument.current=makeDocument();const [documents,setDocuments]=useState<DocumentModel[]>([initialDocument.current]);const documentsRef=useRef(documents);documentsRef.current=documents;const [activeDocumentId,setActiveDocumentId]=useState(initialDocument.current.id);const [size,setSize]=useState(initialDocument.current.size); const [layers,setLayers]=useState<Layer[]>(initialDocument.current.layers); const [active,setActive]=useState<number>(initialDocument.current.activeLayerId); const [selectedIds,setSelectedIds]=useState<number[]>(initialDocument.current.selectedLayerIds); const [tool,setTool]=useState<Tool>('brush'); const [shapeDefaults,setShapeDefaults]=useState<ShapeLayerData>({kind:'rectangle',fillEnabled:true,fill:'#f1f0ed',strokeEnabled:false,stroke:'#171717',strokeWidth:3,cornerRadius:18,sides:5,points:5}); const [shapeDraft,setShapeDraft]=useState<{x:number;y:number;width:number;height:number;kind:VectorShapeKind}|null>(null); const [textEditor,setTextEditor]=useState<{layerId:number;data:TextLayerData}|null>(null); const textEditBefore=useRef<DocumentSnapshot|null>(null); const [cropRect,setCropRect]=useState<{x:number;y:number;width:number;height:number}|null>(null); const [cropRatio,setCropRatio]=useState('free'); const cropAction=useRef<'draw'|'move'|'nw'|'ne'|'sw'|'se'>('draw'); const cropOrigin=useRef<{x:number;y:number;width:number;height:number}|null>(null); const transformBefore=useRef<DocumentSnapshot|null>(null); const transformAction=useRef<'move'|'resize'>('move'); const [color,setColor]=useState('#f1f0ed'); const [bg,setBg]=useState(initialDocument.current.background); const [brushSize,setBrushSize]=useState(DEFAULT_BRUSH_SETTINGS.size); const [hardness,setHardness]=useState(DEFAULT_BRUSH_SETTINGS.hardness); const [opacity,setOpacity]=useState(DEFAULT_BRUSH_SETTINGS.opacity); const [flow,setFlow]=useState(DEFAULT_BRUSH_SETTINGS.flow); const [spacing,setSpacing]=useState(DEFAULT_BRUSH_SETTINGS.spacing); const [smoothing,setSmoothing]=useState(DEFAULT_BRUSH_SETTINGS.smoothing); const [brushBlend,setBrushBlend]=useState<GlobalCompositeOperation>(DEFAULT_BRUSH_SETTINGS.blend); const [brushTip,setBrushTip]=useState<BrushEngineSettings['tip']>(DEFAULT_BRUSH_SETTINGS.tip); const [pressureSize,setPressureSize]=useState(false); const [pressureOpacity,setPressureOpacity]=useState(false); const [pressureFlow,setPressureFlow]=useState(false); const [brushPresets,setBrushPresets]=useState<BrushPreset[]>(STARTER_BRUSHES); const [activeBrushPreset,setActiveBrushPreset]=useState('hard-round'); const [presetName,setPresetName]=useState(''); const [renamingPreset,setRenamingPreset]=useState(false); const [brushCursor,setBrushCursor]=useState<{x:number;y:number;visible:boolean;pressure:number}>({x:0,y:0,visible:false,pressure:1}); const [zoom,setZoom]=useState(initialDocument.current.zoom); const [selection,setSelection]=useState<SelectionState|null>(initialDocument.current.selection);const [selectionPreview,setSelectionPreview]=useState<SelectionState|null>(null);const [previousSelection,setPreviousSelection]=useState<SelectionState|null>(initialDocument.current.previousSelection);const [paths,setPaths]=useState<VectorPath[]>(initialDocument.current.paths);const [activePathId,setActivePathId]=useState<string|null>(initialDocument.current.activePathId);const [channelView,setChannelView]=useState<ChannelView>(initialDocument.current.channelView);const [renamingPathId,setRenamingPathId]=useState<string|null>(null);const [pathNameDraft,setPathNameDraft]=useState('');const [selectionMode,setSelectionMode]=useState<SelectionMode>('replace');const [selectionFeather,setSelectionFeather]=useState(0);const [selectionAA,setSelectionAA]=useState(true);const [wandTolerance,setWandTolerance]=useState(32);const [wandContiguous,setWandContiguous]=useState(true);const [wandSampleMerged,setWandSampleMerged]=useState(true);const [showSelection,setShowSelection]=useState(true);const [polygonPoints,setPolygonPoints]=useState<SelectionPoint[]>([]);const [polygonCursor,setPolygonCursor]=useState<SelectionPoint|null>(null); const [adjust,setAdjust]=useState({...DEFAULT_ADJUSTMENTS}); const [title,setTitle]=useState(initialDocument.current.name); const [renaming,setRenaming]=useState(false); const [renamingLayerId,setRenamingLayerId]=useState<number|null>(null); const [renameDraft,setRenameDraft]=useState(''); const [showAdjust,setShowAdjust]=useState(false); const [toast,setToast]=useState(''); const [pendingCloseDocumentId,setPendingCloseDocumentId]=useState<string|null>(null); const [appClosePrompt,setAppClosePrompt]=useState(false); const [newDocOpen,setNewDocOpen]=useState(false); const [resizeOpen,setResizeOpen]=useState(false); const [resizeW,setResizeW]=useState('1200'); const [resizeH,setResizeH]=useState('800'); const [resizeLock,setResizeLock]=useState(true); const [resizeSampling,setResizeSampling]=useState<'high'|'medium'|'nearest'>('high'); const [newDocWidth,setNewDocWidth]=useState('1200'); const [newDocHeight,setNewDocHeight]=useState('800'); const [isDragActive,setIsDragActive]=useState(false); const [historyRevision,setHistoryRevision]=useState(0); const [historyLimit,setHistoryLimit]=useState(60); const dragDepth=useRef(0);const historyRef=useRef<{documentId:string,history:DocumentHistory}>({documentId:initialDocument.current.id,history:initialDocument.current.history});
 const projectInputRef=useRef<HTMLInputElement>(null); const viewRef=useRef<HTMLCanvasElement>(null), selectionViewRef=useRef<HTMLCanvasElement>(null), channelViewRef=useRef<HTMLCanvasElement>(null), pathViewRef=useRef<HTMLCanvasElement>(null), stageRef=useRef<HTMLDivElement>(null), drawing=useRef(false), start=useRef({x:0,y:0}), last=useRef({x:0,y:0}), pathPoints=useRef<SelectionPoint[]>([]), movingSelection=useRef(false), snapshot=useRef<ImageData|null>(null), drawingBefore=useRef<DocumentSnapshot|null>(null), pixelTransaction=useRef<{layerId:number,target:'canvas'|'mask',canvas:HTMLCanvasElement,tiles:Map<string,{x:number;y:number;before:ImageData}>}|null>(null),propertyGesture=useRef(false),propertyBefore=useRef<DocumentSnapshot|null>(null),selectionGestureMode=useRef<SelectionMode>('replace'),selectionOrigin=useRef<SelectionState|null>(null),brushSpacing=useRef<BrushSpacingState>({distanceSinceStamp:0}),brushLastPoint=useRef<BrushPoint>({x:0,y:0,pressure:1}),brushSmoothedPoint=useRef<BrushPoint>({x:0,y:0,pressure:1}),compositeCache=useRef(new BoundedSurfaceCache<HTMLCanvasElement>()),maskAlphaCache=useRef(new Map<number,{layer:Layer;size:string;pixels:Uint8ClampedArray}>()),maskAlphaCacheBytes=useRef(0),compositeDirty=useRef<{x:number;y:number;width:number;height:number}|null>(null),compositedDocumentId=useRef(initialDocument.current.id),layerIdentity=useRef(new WeakMap<object,number>()),nextLayerIdentity=useRef(0);
 const [retouchSourcePoint,setRetouchSourcePoint]=useState<SelectionPoint|null>(null);
 const [retouchSourceIndicator,setRetouchSourceIndicator]=useState<SelectionPoint|null>(null);
 const [retouchSourceMode,setRetouchSourceMode]=useState<RetouchSourceMode>('active');
 const [retouchTarget,setRetouchTarget]=useState<RetouchTarget>('pixels');
 const [retouchAligned,setRetouchAligned]=useState(true);
 const [retouchOffsetX,setRetouchOffsetX]=useState(0),[retouchOffsetY,setRetouchOffsetY]=useState(0);
 const retouchStroke=useRef<RetouchStroke|null>(null),retouchTargetAnchor=useRef<RetouchPoint|null>(null);
 const current=layers.find(l=>l.id===active); const currentDocument=documents.find(doc=>doc.id===activeDocumentId)??documents[0];const announce=(s:string)=>{setToast(s);window.setTimeout(()=>setToast(''),1800)};const reportOperationFailure=(operation:string,error:unknown)=>{console.error(`[PixelForge ${operation}] operation failed`,error);announce(`Could not ${operation}: ${error instanceof Error?error.message:'canvas allocation failed'}`)};
 const [exactX,setExactX]=useState(0),[exactY,setExactY]=useState(0),[exactWidth,setExactWidth]=useState(128),[exactHeight,setExactHeight]=useState(128);const [newEffectKind,setNewEffectKind]=useState<EffectKind>('brightnessContrast');
 const updateDocuments=(updater:(previous:DocumentModel[])=>DocumentModel[])=>{const next=updater(documentsRef.current);documentsRef.current=next;setDocuments(next)};
 const [gradientKind,setGradientKind]=useState<GradientKind>('linear');const [gradientPreset,setGradientPreset]=useState<'foreground-background'|'foreground-transparent'|'custom'>('foreground-background');const [gradientStops,setGradientStops]=useState<GradientStop[]>([{position:0,color:'#f1f0ed',opacity:100},{position:1,color:'#ffffff',opacity:100}]);const customGradientInitialized=useRef(false);const [fillOpacity,setFillOpacity]=useState(100);const [fillBlend,setFillBlend]=useState<FillBlendMode>('source-over');const [fillTarget,setFillTarget]=useState<'pixels'|'mask'>('pixels');const [fillSource,setFillSource]=useState<'foreground'|'background'>('foreground');const [floodTolerance,setFloodTolerance]=useState(24);const [floodContiguous,setFloodContiguous]=useState(true);const [floodAntiAlias,setFloodAntiAlias]=useState(true);const [gradientPreview,setGradientPreview]=useState<{start:SelectionPoint;end:SelectionPoint}|null>(null);
 const captureSnapshot=(override:Partial<DocumentSnapshot>={}):DocumentSnapshot=>({name:title,size:{...size},layers:layers.map(layer=>({...layer,effects:layer.effects.map(effect=>({...effect,params:{...effect.params}})),textData:layer.textData?{...layer.textData}:undefined,shapeData:layer.shapeData?{...layer.shapeData}:undefined})),activeLayerId:active,selectedLayerIds:[...selectedIds],selection,previousSelection,paths:paths.map(path=>({...path,subpaths:path.subpaths.map(subpath=>({...subpath,points:subpath.points.map(point=>({...point}))}))})),activePathId,adjustments:{...adjust},background:bg,...override});
 const restoreSnapshot=(state:DocumentSnapshot)=>{setTitle(state.name);setSize({...state.size});setLayers(state.layers.map(layer=>({...layer,effects:layer.effects.map(effect=>({...effect,params:{...effect.params}})),textData:layer.textData?{...layer.textData}:undefined,shapeData:layer.shapeData?{...layer.shapeData}:undefined})));setActive(state.activeLayerId);setSelectedIds([...state.selectedLayerIds]);setSelection(state.selection);setPreviousSelection(state.previousSelection);setPaths(state.paths.map(path=>({...path,subpaths:path.subpaths.map(subpath=>({...subpath,points:subpath.points.map(point=>({...point}))}))})));setActivePathId(state.activePathId);setAdjust({...state.adjustments});setBg(state.background)};
 const setHistory=(documentId:string,history:DocumentHistory)=>{const normalized=trimHistory(history);if(historyRef.current.documentId===documentId)historyRef.current={documentId,history:normalized};updateDocuments(docs=>docs.map(doc=>doc.id===documentId?{...doc,history:normalized,dirty:isHistoryDirty(normalized,doc.savedHistoryId),modifiedAt:Date.now()}:doc));setHistoryRevision(value=>value+1)};
 const recordHistory=(label:string,before:DocumentSnapshot,after:DocumentSnapshot,pixels?:{layerId:number,target:'canvas'|'mask',tiles:PixelTile[]})=>{const docId=activeDocumentId;const prior=historyRef.current.documentId===docId?historyRef.current.history:(documentsRef.current.find(doc=>doc.id===docId)?.history??{entries:[],cursor:0,limit:historyLimit,baseStateId:null});const entry:HistoryEntry={id:`${Date.now()}-${Math.random()}`,label,timestamp:Date.now(),before,after,pixelLayerId:pixels?.layerId,pixelTarget:pixels?.target,pixelTiles:pixels?.tiles,memoryBytes:0};entry.memoryBytes=estimateHistoryBytes(entry);setHistory(docId,pushHistory(prior,entry))};
 const applyHistoryEntry=(entry:HistoryEntry,direction:'undo'|'redo')=>{const state=direction==='undo'?entry.before:entry.after;applyHistoryPixelTiles(entry,direction,layers);restoreSnapshot(state)};
 const undo=()=>{const h=historyRef.current;if(h.documentId!==activeDocumentId||!historyCanUndo(h.history))return;const index=h.history.cursor-1,entry=h.history.entries[index],next={...h.history,cursor:index};applyHistoryEntry(entry,'undo');setHistory(activeDocumentId,next)};
 const redo=()=>{const h=historyRef.current;if(h.documentId!==activeDocumentId||!historyCanRedo(h.history))return;const entry=h.history.entries[h.history.cursor],next={...h.history,cursor:h.history.cursor+1};applyHistoryEntry(entry,'redo');setHistory(activeDocumentId,next)};
 const markCompositeDirty=(rect:{x:number;y:number;width:number;height:number})=>{compositeDirty.current=unionDirtyRect(compositeDirty.current,rect)};
  const jumpHistory=(cursor:number)=>{const currentHistory=historyRef.current;if(currentHistory.documentId!==activeDocumentId)return;const history=currentHistory.history,target=Math.max(0,Math.min(cursor,history.entries.length));if(target===history.cursor)return;const direction=target<history.cursor?'before':'after';const first=direction==='before'?history.cursor-1:history.cursor,last=direction==='before'?target:target-1;for(let i=first;direction==='before'?i>=last:i<=last;i+=direction==='before'?-1:1){const entry=history.entries[i];if(entry)applyHistoryPixelTiles(entry,direction==='before'?'undo':'redo',layers)}const targetState=target===0?history.entries[0]?.before:history.entries[target-1]?.after;if(targetState)restoreSnapshot(targetState);setHistory(activeDocumentId,{...history,cursor:target})};
 const composite=useCallback(()=>{
  try{
  const out=viewRef.current;if(!out)return;
  const sizeChanged=out.width!==size.w||out.height!==size.h,documentChanged=compositedDocumentId.current!==activeDocumentId;
  compositedDocumentId.current=activeDocumentId;
  if(out.width!==size.w)out.width=size.w;if(out.height!==size.h)out.height=size.h;
  const dirty=compositeDirty.current;compositeDirty.current=null;
  compositeCache.current.prune(layers.map(layer=>layer.id));
  const layerIds=new Set(layers.map(layer=>layer.id));
  for(const [id,entry] of maskAlphaCache.current)if(!layerIds.has(id)){maskAlphaCacheBytes.current-=entry.pixels.byteLength;maskAlphaCache.current.delete(id)}
  const ctx=brushReadContext(out),partial=!!dirty&&!sizeChanged&&!documentChanged&&canCompositeRegion(layers,size.w,size.h);
  const childrenByParent=new Map<number|undefined,Layer[]>();
  for(const layer of layers){const siblings=childrenByParent.get(layer.parentId)??[];siblings.push(layer);childrenByParent.set(layer.parentId,siblings)}
  const children=(parentId?:number)=>childrenByParent.get(parentId)??[];
  const identity=(layer:Layer)=>{let id=layerIdentity.current.get(layer);if(id===undefined){id=++nextLayerIdentity.current;layerIdentity.current.set(layer,id)}return id};
  const groupSignatures=new Map<number,string>();
  const groupSignature=(layer:Layer,ancestors=new Set<number>()):string=>{
   const cached=groupSignatures.get(layer.id);if(cached)return cached;
   if(ancestors.has(layer.id))return `cycle-${identity(layer)}`;
   const nextAncestors=new Set(ancestors);nextAncestors.add(layer.id);
   const signature=`${identity(layer)}[${children(layer.id).map(child=>`${identity(child)}${child.type==='group'?groupSignature(child,nextAncestors):''}`).join('|')}]`;
   groupSignatures.set(layer.id,signature);return signature
  };
  let clip:{x:number;y:number;width:number;height:number}|null=null;
  if(partial&&dirty){const x=Math.max(0,Math.floor(dirty.x)),y=Math.max(0,Math.floor(dirty.y)),right=Math.min(size.w,Math.ceil(dirty.x+dirty.width)),bottom=Math.min(size.h,Math.ceil(dirty.y+dirty.height));if(right>x&&bottom>y)clip={x,y,width:right-x,height:bottom-y}}
  if(clip)ctx.clearRect(clip.x,clip.y,clip.width,clip.height);else ctx.clearRect(0,0,size.w,size.h);
  const maskAlpha=(layer:Layer):Uint8ClampedArray|undefined=>{
   if(!layer.mask||!layer.maskEnabled)return undefined;
   const cached=maskAlphaCache.current.get(layer.id),cacheSize=`${size.w}x${size.h}`;
   if(cached&&cached.layer===layer&&cached.size===cacheSize){maskAlphaCache.current.delete(layer.id);maskAlphaCache.current.set(layer.id,cached);return cached.pixels}
   const surface=mkCanvas(size.w,size.h),context=surface.getContext('2d')!,width=layer.width||size.w,height=layer.height||size.h;
   context.translate(layer.x+width/2,layer.y+height/2);context.rotate((layer.rotation||0)*Math.PI/180);
   if(layer.flipX||layer.flipY)context.scale(layer.flipX?-1:1,layer.flipY?-1:1);
   context.drawImage(layer.mask,-width/2,-height/2,width,height);
   const image=context.getImageData(0,0,size.w,size.h),alpha=new Uint8ClampedArray(size.w*size.h);
   for(let index=0,pixel=0;index<image.data.length;index+=4,pixel++)alpha[pixel]=image.data[index+3];
   if(alpha.byteLength<=MAX_MASK_ALPHA_CACHE_BYTES){
    if(cached){maskAlphaCacheBytes.current-=cached.pixels.byteLength;maskAlphaCache.current.delete(layer.id)}
    while(maskAlphaCacheBytes.current+alpha.byteLength>MAX_MASK_ALPHA_CACHE_BYTES){const oldest=maskAlphaCache.current.keys().next().value;if(oldest===undefined)break;const removed=maskAlphaCache.current.get(oldest);if(removed)maskAlphaCacheBytes.current-=removed.pixels.byteLength;maskAlphaCache.current.delete(oldest)}
    maskAlphaCache.current.set(layer.id,{layer,size:cacheSize,pixels:alpha});maskAlphaCacheBytes.current+=alpha.byteLength
   }
   return alpha
  };
  const applyAdjustment=(target:CanvasRenderingContext2D,layer:Layer)=>{
   const enabledEffects=layer.effects.filter(effect=>effect.enabled);
   if(!enabledEffects.length||layer.opacity<=0)return;
   const base=target.getImageData(0,0,size.w,size.h),mask=maskAlpha(layer);
   const result=applyAdjustmentLayerPixels(base.data,size.w,size.h,enabledEffects,layer.opacity,mask,layer.visible,layer.blend as AdjustmentBlendMode),image=target.createImageData(size.w,size.h);
   image.data.set(result);target.putImageData(image,0,0)
  };
  const draw=(target:CanvasRenderingContext2D,parentId?:number)=>{
   for(const layer of children(parentId)){
    if(!layer.visible)continue;
    if(layer.type==='group'){
     const cached=compositeCache.current.acquire(layer.id,groupSignature(layer),size.w,size.h,()=>mkCanvas(size.w,size.h),(canvas,w,h)=>{canvas.width=w;canvas.height=h});
     const groupCanvas=cached?.canvas??mkCanvas(size.w,size.h);
     if(!cached||cached.needsRender){
      const context=groupCanvas.getContext('2d')!;context.clearRect(0,0,size.w,size.h);draw(context,layer.id);
      if(layer.effects.some(effect=>effect.enabled)){const source=context.getImageData(0,0,size.w,size.h),pixels=applyEffectStack(source.data,size.w,size.h,layer.effects),result=context.createImageData(size.w,size.h);result.data.set(pixels);context.putImageData(result,0,0)}
     }
     const width=layer.width||size.w,height=layer.height||size.h;
     target.save();target.globalAlpha=layer.opacity/100;target.globalCompositeOperation=layer.blend;
     target.translate(layer.x+width/2,layer.y+height/2);target.rotate((layer.rotation||0)*Math.PI/180);
     target.drawImage(groupCanvas,-width/2,-height/2,width,height);target.restore();continue
    }
    if(layer.type==='adjustment'){applyAdjustment(target,layer);continue}
    const width=layer.width||layer.canvas.width,height=layer.height||layer.canvas.height;
    const masked=!!layer.mask&&layer.maskEnabled,effected=layer.effects.some(effect=>effect.enabled),isolated=masked||effected;
    const render=(destination:CanvasRenderingContext2D,applyMask:boolean)=>{
     destination.save();destination.globalAlpha=isolated?1:layer.opacity/100;
     destination.globalCompositeOperation=isolated?'source-over':layer.blend;destination.filter=layer.filter;
     destination.translate(layer.x+width/2,layer.y+height/2);destination.rotate((layer.rotation||0)*Math.PI/180);
     if(layer.flipX||layer.flipY)destination.scale(layer.flipX?-1:1,layer.flipY?-1:1);
     if(layer.type==='text'||layer.type==='shape'){destination.translate(-width/2,-height/2);drawVectorLayer(destination,layer)}
     else destination.drawImage(layer.canvas,-width/2,-height/2,width,height);
     if(applyMask&&layer.mask){destination.filter='none';destination.globalCompositeOperation='destination-in';destination.drawImage(layer.mask,-width/2,-height/2,width,height)}
     destination.restore()
    };
    if(isolated){
     const cached=compositeCache.current.acquire(layer.id,layer,size.w,size.h,()=>mkCanvas(size.w,size.h),(canvas,w,h)=>{canvas.width=w;canvas.height=h});
     const surface=cached?.canvas??mkCanvas(size.w,size.h);
     if(!cached||cached.needsRender){
      const context=surface.getContext('2d')!;context.clearRect(0,0,size.w,size.h);render(context,false);
      if(effected){const source=context.getImageData(0,0,size.w,size.h),pixels=applyEffectStack(source.data,size.w,size.h,layer.effects),result=context.createImageData(size.w,size.h);result.data.set(pixels);context.putImageData(result,0,0)}
      if(masked){context.save();context.filter='none';context.globalCompositeOperation='destination-in';context.translate(layer.x+width/2,layer.y+height/2);context.rotate((layer.rotation||0)*Math.PI/180);if(layer.flipX||layer.flipY)context.scale(layer.flipX?-1:1,layer.flipY?-1:1);context.drawImage(layer.mask!,-width/2,-height/2,width,height);context.restore()}
     }
     target.save();target.globalAlpha=layer.opacity/100;target.globalCompositeOperation=layer.blend;target.drawImage(surface,0,0);target.restore()
    }else render(target,false)
   }
  };
  if(clip){ctx.save();ctx.beginPath();ctx.rect(clip.x,clip.y,clip.width,clip.height);ctx.clip();draw(ctx);ctx.restore()}else draw(ctx)
  }catch(error){compositeDirty.current=null;compositeCache.current.clear();maskAlphaCache.current.clear();maskAlphaCacheBytes.current=0;console.error('[PixelForge renderer] compositing failed',error);announce('Could not render document: '+(error instanceof Error?error.message:'canvas allocation failed'))}
 },[activeDocumentId,layers,size]);
 useEffect(()=>{composite()},[layers,composite,size]);
 useEffect(()=>{
  const canvas=channelViewRef.current,source=viewRef.current;if(!canvas||!source)return;
  canvas.style.opacity=channelView==='rgb'?'0':'1';
  if(channelView==='rgb')return;
  if(canvas.width!==size.w)canvas.width=size.w;if(canvas.height!==size.h)canvas.height=size.h;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  if(!ctx){console.error('[PixelForge channels] preview canvas context unavailable');announce('Could not render channel preview');return}
  ctx.clearRect(0,0,size.w,size.h);
  try{ctx.drawImage(source,0,0);const image=ctx.getImageData(0,0,size.w,size.h);image.data.set(createChannelPreview(image.data,channelView));ctx.putImageData(image,0,0)}
  catch(error){console.error('[PixelForge channels] preview rendering failed',error);announce('Could not render channel preview')}
 },[channelView,size,layers,adjust]);
 useEffect(()=>{
  const canvas=pathViewRef.current;if(!canvas)return;
  if(canvas.width!==size.w)canvas.width=size.w;if(canvas.height!==size.h)canvas.height=size.h;
  const ctx=canvas.getContext('2d');if(!ctx){console.error('[PixelForge paths] path overlay context unavailable');return}
  ctx.clearRect(0,0,size.w,size.h);const scale=Math.max(.1,zoom/100);
  for(const path of paths){if(!path.visible)continue;const selected=path.id===activePathId;ctx.beginPath();for(const subpath of path.subpaths){if(!subpath.points.length)continue;ctx.moveTo(subpath.points[0].x,subpath.points[0].y);for(let index=1;index<subpath.points.length;index++)ctx.lineTo(subpath.points[index].x,subpath.points[index].y);if(subpath.closed)ctx.closePath()}ctx.lineJoin='round';ctx.lineCap='round';ctx.setLineDash([]);ctx.lineWidth=3/scale;ctx.strokeStyle='#151515';ctx.stroke();ctx.setLineDash([6/scale,3/scale]);ctx.lineWidth=1.5/scale;ctx.strokeStyle=selected?'#42d3ff':'#ffd45b';ctx.stroke();const anchors=path.subpaths.reduce((total,subpath)=>total+subpath.points.length,0);if(selected&&anchors<=2000){ctx.setLineDash([]);for(const subpath of path.subpaths)for(const point of subpath.points){ctx.beginPath();ctx.arc(point.x,point.y,3/scale,0,Math.PI*2);ctx.fillStyle='#13202a';ctx.fill();ctx.lineWidth=1/scale;ctx.strokeStyle='#a5edff';ctx.stroke()}}}
 },[paths,activePathId,size,zoom]);
 const selectionOutline=useMemo(()=>marchingAntsPath(showSelection?(selectionPreview??selection):null),[selection,selectionPreview,showSelection]);
 useEffect(()=>{
  const canvas=selectionViewRef.current;if(!canvas)return;if(canvas.width!==size.w)canvas.width=size.w;if(canvas.height!==size.h)canvas.height=size.h;
  const ctx=canvas.getContext('2d');if(!ctx)return;
  if(!selectionOutline&&!(tool==='lasso'&&drawing.current)&&!(tool==='gradient'&&gradientPreview)&&!((tool==='clone'||tool==='healing')&&(retouchSourceIndicator||brushCursor.visible))){ctx.clearRect(0,0,size.w,size.h);return}
  let raf=0;
  const draw=(time:number)=>{
   ctx.clearRect(0,0,size.w,size.h);
   if(tool==='gradient'&&gradientPreview){
    const {start,end}=gradientPreview,radius=Math.max(.5,Math.hypot(end.x-start.x,end.y-start.y)),preview=gradientKind==='radial'?ctx.createRadialGradient(start.x,start.y,0,start.x,start.y,radius):ctx.createLinearGradient(start.x,start.y,end.x,end.y);
    for(const stop of resolvedGradientStops){const hex=stop.color.slice(1),red=parseInt(hex.slice(0,2),16),green=parseInt(hex.slice(2,4),16),blue=parseInt(hex.slice(4,6),16),luminance=(red*.2126+green*.7152+blue*.0722)/255,opacity=stop.opacity/100*fillOpacity/100*(fillTarget==='mask'?luminance:1);preview.addColorStop(stop.position,`rgba(${fillTarget==='mask'?255:red},${fillTarget==='mask'?255:green},${fillTarget==='mask'?255:blue},${opacity})`)}
    ctx.save();ctx.globalAlpha=.48;ctx.fillStyle=preview;ctx.fillRect(0,0,size.w,size.h);ctx.restore();
    const scale=Math.max(.1,zoom/100);ctx.save();ctx.lineWidth=1.5/scale;ctx.setLineDash([5/scale,4/scale]);ctx.strokeStyle='#fff';ctx.beginPath();ctx.moveTo(start.x,start.y);ctx.lineTo(end.x,end.y);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(start.x,start.y,4/scale,0,Math.PI*2);ctx.arc(end.x,end.y,4/scale,0,Math.PI*2);ctx.fill();if(gradientKind==='radial'){ctx.beginPath();ctx.arc(start.x,start.y,radius,0,Math.PI*2);ctx.stroke()}ctx.restore()
   }
   ctx.save();const scale=Math.max(.1,zoom/100);ctx.lineWidth=1/scale;ctx.setLineDash([4/scale,4/scale]);if(selectionOutline){ctx.lineDashOffset=-(time/70)%(8/scale);ctx.strokeStyle='#f5f5f5';ctx.stroke(selectionOutline);ctx.lineDashOffset+=4/scale;ctx.strokeStyle='#171717';ctx.stroke(selectionOutline)}if(tool==='lasso'&&drawing.current&&pathPoints.current.length>1){const points=pathPoints.current,step=Math.max(1,Math.ceil(points.length/2000));ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);for(let index=step;index<points.length;index+=step)ctx.lineTo(points[index].x,points[index].y);ctx.lineTo(points[points.length-1].x,points[points.length-1].y);ctx.lineDashOffset=0;ctx.strokeStyle='#58a6ff';ctx.stroke()}if((tool==='clone'||tool==='healing')&&brushCursor.visible){ctx.setLineDash([]);ctx.beginPath();ctx.arc(brushCursor.x,brushCursor.y,brushSize*(pressureSize?brushCursor.pressure:1)/2,0,Math.PI*2);ctx.strokeStyle='#fff';ctx.stroke();ctx.beginPath();ctx.arc(brushCursor.x,brushCursor.y,brushSize*(pressureSize?brushCursor.pressure:1)/2+1/scale,0,Math.PI*2);ctx.strokeStyle='#111';ctx.stroke()}if((tool==='clone'||tool==='healing')&&retouchSourceIndicator){ctx.setLineDash([]);const {x,y}=retouchSourceIndicator,r=5/scale;ctx.strokeStyle='#05202b';ctx.lineWidth=3/scale;ctx.beginPath();ctx.moveTo(x-r,y);ctx.lineTo(x+r,y);ctx.moveTo(x,y-r);ctx.lineTo(x,y+r);ctx.stroke();ctx.strokeStyle='#6be5ff';ctx.lineWidth=1/scale;ctx.stroke()}ctx.restore();raf=requestAnimationFrame(draw)
  };
  raf=requestAnimationFrame(draw);return()=>cancelAnimationFrame(raf)
 },[selectionOutline,size,zoom,tool,gradientPreview,gradientKind,gradientStops,gradientPreset,color,bg,fillOpacity,fillTarget,selection,retouchSourceIndicator,brushCursor,brushSize,pressureSize]);
  useEffect(()=>{updateDocuments(docs=>docs.map(doc=>doc.id===activeDocumentId?{...doc,name:title,size:{...size},layers,activeLayerId:active,selectedLayerIds:selectedIds,selection,previousSelection,paths,activePathId,channelView,adjustments:{...adjust},background:bg,zoom,modifiedAt:Date.now()}:doc))},[activeDocumentId,title,size,layers,active,selectedIds,selection,previousSelection,paths,activePathId,channelView,adjust,bg,zoom]);
 useEffect(()=>{if(selection?.bounds){setExactX(selection.bounds.x);setExactY(selection.bounds.y);setExactWidth(selection.bounds.width);setExactHeight(selection.bounds.height)}},[selection]);
 useEffect(()=>{const doc=documentsRef.current.find(item=>item.id===activeDocumentId);if(doc)historyRef.current={documentId:doc.id,history:doc.history}},[activeDocumentId]);
 const point=(e:React.PointerEvent)=>{const r=viewRef.current!.getBoundingClientRect();return{x:(e.clientX-r.left)*size.w/r.width,y:(e.clientY-r.top)*size.h/r.height}};
 const cropConstrain=(rect:{x:number;y:number;width:number;height:number})=>{if(cropRatio==='free')return rect;const [rw,rh]=(cropRatio==='original'?`${size.w}:${size.h}`:cropRatio).split(':').map(Number),ratio=rw/rh,width=Math.max(1,rect.width),height=Math.max(1,rect.height);return width/height>ratio?{...rect,width:height*ratio}:{...rect,height:width/ratio}};
 const setCropDimension=(key:'x'|'y'|'width'|'height',value:number)=>setCropRect(r=>{if(!r)return r;const next={...r,[key]:value};return cropConstrain(next)}); const beginTransformEdit=()=>{if(!transformBefore.current)transformBefore.current=captureSnapshot()}; const endTransformEdit=()=>{const before=transformBefore.current;if(!before)return;transformBefore.current=null;const after=captureSnapshot();if(before.layers.some((layer,index)=>['x','y','width','height','rotation'].some(key=>layer[key as keyof Layer]!==after.layers[index]?.[key as keyof Layer])))recordHistory('Transform layer',before,after)};
 const beginCrop=(p:{x:number;y:number})=>{let action:'draw'|'move'|'nw'|'ne'|'sw'|'se'='draw';if(cropRect){const corners:['nw'|'ne'|'sw'|'se',number,number][]=[['nw',cropRect.x,cropRect.y],['ne',cropRect.x+cropRect.width,cropRect.y],['sw',cropRect.x,cropRect.y+cropRect.height],['se',cropRect.x+cropRect.width,cropRect.y+cropRect.height]],near=corners.find(([,x,y])=>Math.hypot(p.x-x,p.y-y)<14/Math.max(.1,zoom/100));if(near)action=near[0];else if(p.x>=cropRect.x&&p.x<=cropRect.x+cropRect.width&&p.y>=cropRect.y&&p.y<=cropRect.y+cropRect.height)action='move'}cropAction.current=action;cropOrigin.current=cropRect?{...cropRect}:null;start.current=action==='nw'&&cropRect?{x:cropRect.x,y:cropRect.y}:action==='ne'&&cropRect?{x:cropRect.x+cropRect.width,y:cropRect.y}:action==='sw'&&cropRect?{x:cropRect.x,y:cropRect.y+cropRect.height}:action==='se'&&cropRect?{x:cropRect.x+cropRect.width,y:cropRect.y+cropRect.height}:p;if(action==='draw')setCropRect({x:p.x,y:p.y,width:1,height:1});drawing.current=true};
 const applyCrop=()=>{
  if(!cropRect)return;
  const x=Math.round(cropRect.x),y=Math.round(cropRect.y),w=Math.max(1,Math.round(cropRect.width)),h=Math.max(1,Math.round(cropRect.height));
  try { assertCanvasDimensions(w,h); }
  catch(error) { announce(error instanceof Error?error.message:'Crop dimensions are invalid');return }
  try {
  const before=captureSnapshot();
  const cropMask=(layer:Layer,width:number,height:number)=>{
   if(!layer.mask)return undefined;
   const rendered=mkCanvas(size.w,size.h),context=rendered.getContext('2d')!;
   context.translate(layer.x+width/2,layer.y+height/2);context.rotate((layer.rotation||0)*Math.PI/180);
   if(layer.flipX||layer.flipY)context.scale(layer.flipX?-1:1,layer.flipY?-1:1);
   context.drawImage(layer.mask,-width/2,-height/2,width,height);
   const mask=mkCanvas(w,h);mask.getContext('2d')!.drawImage(rendered,-x,-y);return mask
  };
  const next=layers.map(layer=>{
   if(layer.type==='group')return {...layer,x:0,y:0,width:w,height:h,rotation:0};
   if(layer.type==='adjustment')return {...layer,mask:cropMask(layer,layer.width,layer.height),x:0,y:0,width:w,height:h,rotation:0,flipX:false,flipY:false};
   if(layer.type==='text'||layer.type==='shape')return {...layer,x:layer.x-x,y:layer.y-y};
   const width=layer.width||layer.canvas.width,height=layer.height||layer.canvas.height,rendered=mkCanvas(size.w,size.h),context=rendered.getContext('2d')!;
   context.translate(layer.x+width/2,layer.y+height/2);context.rotate((layer.rotation||0)*Math.PI/180);context.drawImage(layer.canvas,-width/2,-height/2,width,height);
   const canvas=mkCanvas(w,h);canvas.getContext('2d')!.drawImage(rendered,-x,-y);
   const mask=cropMask(layer,width,height);
   return {...layer,canvas,mask,x:0,y:0,width:w,height:h,rotation:0}
  });
  const nextSelection=cropSelection(selection,x,y,w,h),nextPrevious=cropSelection(previousSelection,x,y,w,h),nextPaths=mapVectorPaths(paths,point=>({x:point.x-x,y:point.y-y}));
  setSize({w,h});setLayers(next);setSelection(nextSelection);setPreviousSelection(nextPrevious);setPaths(nextPaths);setCropRect(null);setTool('move');
  recordHistory('Crop document',before,{...before,size:{w,h},layers:next,selection:nextSelection,previousSelection:nextPrevious,paths:nextPaths});announce(`Cropped to ${w} x ${h}`)
  } catch(error) { console.error('[PixelForge crop] operation failed',error);announce('Could not crop document: '+(error instanceof Error?error.message:'canvas allocation failed')) }
 };
 const cancelCrop=()=>{setCropRect(null);drawing.current=false;announce('Crop cancelled')};
 const applyTransform=(patch:Partial<Pick<Layer,'x'|'y'|'width'|'height'|'rotation'>>) => {if(!current||current.type==='adjustment'||current.locked)return;const before=transformBefore.current??captureSnapshot(),commit=!transformBefore.current,next=layers.map(layer=>layer.id===current.id?{...layer,...patch,width:Math.max(1,patch.width??layer.width),height:Math.max(1,patch.height??layer.height),rotation:patch.rotation??layer.rotation??0}:layer);setLayers(next);if(commit)recordHistory('Transform layer',before,{...before,layers:next})};
 const resizeImage=()=>{setResizeW(String(size.w));setResizeH(String(size.h));setResizeOpen(true)};
 const commitResize=()=>{
  const w=Number(resizeW),requestedH=Number(resizeH);
  if(!Number.isSafeInteger(w)||!Number.isSafeInteger(requestedH)||w<1||requestedH<1||w>MAX_DOCUMENT_DIMENSION||requestedH>MAX_DOCUMENT_DIMENSION)return announce(`Enter dimensions from 1 to ${MAX_DOCUMENT_DIMENSION.toLocaleString()} pixels`);
  const sx=w/size.w,sy=resizeLock?sx:requestedH/size.h,h=resizeLock?Math.max(1,Math.round(size.h*sy)):requestedH,before=captureSnapshot();
  try { assertCanvasDimensions(w,h); }
  catch(error) { announce(error instanceof Error?error.message:'Resize dimensions are invalid');return }
  try {
  const next=layers.map(layer=>{
   if(layer.type==='group'||layer.type==='text'||layer.type==='shape')return {...layer,x:layer.x*sx,y:layer.y*sy,width:layer.width*sx,height:layer.height*sy};
   if(layer.type==='adjustment'){
    let mask:HTMLCanvasElement|undefined;
    if(layer.mask){mask=mkCanvas(w,h);const context=mask.getContext('2d')!;context.imageSmoothingEnabled=resizeSampling!=='nearest';context.imageSmoothingQuality=resizeSampling==='high'?'high':'medium';context.drawImage(layer.mask,0,0,w,h)}
    return {...layer,mask,x:0,y:0,width:w,height:h,rotation:0,flipX:false,flipY:false}
   }
   const canvas=mkCanvas(w,h),context=canvas.getContext('2d')!;
   context.imageSmoothingEnabled=resizeSampling!=='nearest';context.imageSmoothingQuality=resizeSampling==='high'?'high':'medium';context.drawImage(layer.canvas,0,0,w,h);
   let mask:HTMLCanvasElement|undefined;
   if(layer.mask){mask=mkCanvas(w,h);const maskContext=mask.getContext('2d')!;maskContext.imageSmoothingEnabled=resizeSampling!=='nearest';maskContext.imageSmoothingQuality=resizeSampling==='high'?'high':'medium';maskContext.drawImage(layer.mask,0,0,w,h)}
   return {...layer,canvas,mask,x:layer.x*sx,y:layer.y*sy,width:layer.width*sx,height:layer.height*sy}
  });
  const resizedSelection=mapSelection(selection,w,h,(x,y)=>({x:x*sx,y:y*sy})),resizedPrevious=mapSelection(previousSelection,w,h,(x,y)=>({x:x*sx,y:y*sy})),resizedPaths=mapVectorPaths(paths,point=>({x:point.x*sx,y:point.y*sy}));
  setSize({w,h});setLayers(next);setSelection(resizedSelection);setPreviousSelection(resizedPrevious);setPaths(resizedPaths);setResizeOpen(false);
  recordHistory('Resize image',before,{...before,size:{w,h},layers:next,selection:resizedSelection,previousSelection:resizedPrevious,paths:resizedPaths});announce(`Image resized to ${w} x ${h}`)
  } catch(error) { console.error('[PixelForge resize] operation failed',error);announce('Could not resize image: '+(error instanceof Error?error.message:'canvas allocation failed')) }
 };
 const rotateCanvas=(angle:90|180|270|0|-1)=>{
  try{
  const flipX=angle===0,flipY=angle===-1,before=captureSnapshot(),nw=angle===90||angle===270?size.h:size.w,nh=angle===90||angle===270?size.w:size.h;
  const bake=(source:HTMLCanvasElement,layer:Layer)=>{const staged=mkCanvas(size.w,size.h),ctx=staged.getContext('2d')!,w=layer.width||source.width,h=layer.height||source.height;ctx.translate(layer.x+w/2,layer.y+h/2);ctx.rotate((layer.rotation||0)*Math.PI/180);ctx.drawImage(source,-w/2,-h/2,w,h);return staged};
  const orient=(source:HTMLCanvasElement,layer:Layer)=>{const staged=bake(source,layer),canvas=mkCanvas(nw,nh),ctx=canvas.getContext('2d')!;if(flipX){ctx.translate(nw,0);ctx.scale(-1,1);ctx.drawImage(staged,0,0)}else if(flipY){ctx.translate(0,nh);ctx.scale(1,-1);ctx.drawImage(staged,0,0)}else{ctx.translate(nw/2,nh/2);ctx.rotate(angle*Math.PI/180);ctx.drawImage(staged,-size.w/2,-size.h/2)}return canvas};
  const next=layers.map(layer=>{
   if(layer.type==='group')return {...layer,x:0,y:0,width:nw,height:nh,rotation:0};
   if(layer.type==='adjustment'){
    const mask=layer.mask?orient(layer.mask,layer):undefined;
    return {...layer,mask,x:0,y:0,width:nw,height:nh,rotation:0,flipX:false,flipY:false}
   }
   if(layer.type==='text'||layer.type==='shape'){
    const cx=layer.x+layer.width/2,cy=layer.y+layer.height/2;let nx=cx,ny=cy,nwidth=layer.width,nheight=layer.height,rotation=layer.rotation||0,fx=!!layer.flipX,fy=!!layer.flipY;
    if(flipX){nx=size.w-cx;fx=!fx}else if(flipY){ny=size.h-cy;fy=!fy}else if(angle===90){nx=size.h-cy;ny=cx;nwidth=layer.height;nheight=layer.width;rotation+=90}else if(angle===180){nx=size.w-cx;ny=size.h-cy;rotation+=180}else{nx=cy;ny=size.w-cx;nwidth=layer.height;nheight=layer.width;rotation-=90}
    return {...layer,x:nx-nwidth/2,y:ny-nheight/2,width:nwidth,height:nheight,rotation,flipX:fx,flipY:fy};
   }
   const canvas=orient(layer.canvas,layer),mask=layer.mask?orient(layer.mask,layer):undefined;
   return {...layer,canvas,mask,x:0,y:0,width:nw,height:nh,rotation:0};
  });
  const mapPoint=(x:number,y:number)=>flipX?{x:size.w-1-x,y}:flipY?{x,y:size.h-1-y}:angle===90?{x:size.h-1-y,y:x}:angle===180?{x:size.w-1-x,y:size.h-1-y}:{x:y,y:size.w-1-x};
  const mapPathPoint=(point:SelectionPoint)=>flipX?{x:size.w-point.x,y:point.y}:flipY?{x:point.x,y:size.h-point.y}:angle===90?{x:size.h-point.y,y:point.x}:angle===180?{x:size.w-point.x,y:size.h-point.y}:{x:point.y,y:size.w-point.x};
  const nextSelection=mapSelection(selection,nw,nh,mapPoint),nextPrevious=mapSelection(previousSelection,nw,nh,mapPoint),nextPaths=mapVectorPaths(paths,mapPathPoint);
  setSize({w:nw,h:nh});setLayers(next);setSelection(nextSelection);setPreviousSelection(nextPrevious);setPaths(nextPaths);
  recordHistory(flipX?'Flip canvas horizontally':flipY?'Flip canvas vertically':`Rotate canvas ${angle} degrees`,before,{...before,size:{w:nw,h:nh},layers:next,selection:nextSelection,previousSelection:nextPrevious,paths:nextPaths});
  announce(flipX?'Canvas flipped horizontally':flipY?'Canvas flipped vertically':`Canvas rotated ${angle} degrees`)
  }catch(error){reportOperationFailure('rotate canvas',error)}
 };
 const applySelectionPixels=(canvas:HTMLCanvasElement,before:ImageData,rect:{x:number;y:number;width:number;height:number})=>{if(!selection)return;const ctx=canvas.getContext('2d')!,after=ctx.getImageData(rect.x,rect.y,rect.width,rect.height);for(let y=0;y<rect.height;y++)for(let x=0;x<rect.width;x++){const i=(y*rect.width+x)*4,a=maskAlphaAt(selection.mask,rect.x+x,rect.y+y)/255;if(a>=1)continue;if(a<=0){after.data.set(before.data.subarray(i,i+4),i);continue}for(let c=0;c<4;c++)after.data[i+c]=Math.round(before.data[i+c]*(1-a)+after.data[i+c]*a)}ctx.putImageData(after,rect.x,rect.y)};
 const capturePixelTiles=(canvas:HTMLCanvasElement,bounds:{left:number,top:number,right:number,bottom:number})=>{
  const transaction=pixelTransaction.current;if(!transaction)return;
  const left=Math.max(0,Math.floor(bounds.left)),top=Math.max(0,Math.floor(bounds.top)),right=Math.min(canvas.width,Math.ceil(bounds.right)),bottom=Math.min(canvas.height,Math.ceil(bounds.bottom));
  if(right<=left||bottom<=top)return;
  const tileSize=128,ctx=brushReadContext(canvas),stroke=retouchStroke.current;
  for(let y=Math.floor(top/tileSize)*tileSize;y<bottom;y+=tileSize)for(let x=Math.floor(left/tileSize)*tileSize;x<right;x+=tileSize){
   const key=`${x}:${y}`;if(transaction.tiles.has(key))continue;
   const w=Math.min(tileSize,canvas.width-x),h=Math.min(tileSize,canvas.height-y),before=ctx.getImageData(x,y,w,h);
   transaction.tiles.set(key,{x,y,before});
   if(stroke){
    if(stroke.sourceMode==='merged'&&!stroke.mergedTiles.has(key)){
     const merged=viewRef.current;
     if(merged&&x<merged.width&&y<merged.height)stroke.mergedTiles.set(key,brushReadContext(merged).getImageData(x,y,Math.min(w,merged.width-x),Math.min(h,merged.height-y)))
    }
   }
  }
 };
 const beginPixelTransaction=(layerId:number,target:'canvas'|'mask',canvas:HTMLCanvasElement)=>{pixelTransaction.current={layerId,target,canvas,tiles:new Map()}};
 const finishPixelTransaction=(respectSelection=true,enableMask=true,label?:string)=>{
  const transaction=pixelTransaction.current,before=drawingBefore.current;
  if(!transaction||!before){pixelTransaction.current=null;drawingBefore.current=null;return}
  const ctx=brushReadContext(transaction.canvas),tiles:PixelTile[]=[];
  const layer=before.layers.find(item=>item.id===transaction.layerId);
  for(const tile of transaction.tiles.values()){
   const after=ctx.getImageData(tile.x,tile.y,tile.before.width,tile.before.height);
   if(respectSelection&&selection&&layer){
    for(let y=0;y<tile.before.height;y++)for(let x=0;x<tile.before.width;x++){
     const px=tile.x+x,py=tile.y+y,docPoint=transaction.target==='mask'?maskToDocumentPoint({x:px+.5,y:py+.5},layer):{x:px,y:py};
     const alpha=maskAlphaAt(selection.mask,Math.floor(docPoint.x),Math.floor(docPoint.y))/255,i=(y*tile.before.width+x)*4;
     if(alpha>=1)continue;
     if(alpha<=0){after.data.set(tile.before.data.subarray(i,i+4),i);continue}
     for(let c=0;c<4;c++)after.data[i+c]=Math.round(tile.before.data[i+c]*(1-alpha)+after.data[i+c]*alpha)
    }
    ctx.putImageData(after,tile.x,tile.y)
   }
   let changed=false;
   for(let i=0;i<after.data.length;i++)if(after.data[i]!==tile.before.data[i]){changed=true;break}
   if(changed)tiles.push({...tile,after})
  }
  pixelTransaction.current=null;drawingBefore.current=null;
  const afterLayers=transaction.target==='mask'?before.layers.map(item=>item.id===transaction.layerId?{...item,mask:transaction.canvas,maskEnabled:enableMask?true:item.maskEnabled,maskMode:'alpha' as const}:item):layers.map(item=>item.id===transaction.layerId?{...item}:item);
  const maskStateChanged=transaction.target==='mask'&&enableMask&&before.layers.some(item=>item.id===transaction.layerId&&(!item.mask||!item.maskEnabled));
  if(!tiles.length&&!maskStateChanged)return;
  const after=captureSnapshot({layers:afterLayers});
  setLayers(afterLayers);
  recordHistory(label??(transaction.target==='mask'?'Paint layer mask':tool==='eraser'?'Erase pixels':tool==='rectangle'||tool==='ellipse'?'Draw shape':tool==='move'?'Move layer':tool==='text'?'Add text':'Paint pixels'),before,after,tiles.length?{layerId:transaction.layerId,target:transaction.target,tiles}:undefined)
 };
 const commitSelection=(incoming:SelectionState,label='Selection',mode:SelectionMode=selectionMode,applyFeather=true)=>{const prepared=applyFeather&&selectionFeather>0?featherSelection(incoming,selectionFeather):incoming,before=captureSnapshot(),next=combineSelection(selection,prepared,mode);setPreviousSelection(selection);setSelection(next);recordHistory(label,before,{...before,selection:next,previousSelection:selection})};
 const applyExactSelection=()=>{const x=Math.max(0,Math.min(size.w-1,exactX)),y=Math.max(0,Math.min(size.h-1,exactY)),w=Math.max(1,Math.min(size.w-x,exactWidth)),h=Math.max(1,Math.min(size.h-y,exactHeight));commitSelection(rasterizeSelection(size.w,size.h,'rect',{x,y},{x:x+w,y:y+h},[],selectionAA),'Exact rectangular selection','replace')};
 const clearSelection=()=>{if(!selection)return;const before=captureSnapshot();setPreviousSelection(selection);setSelection(null);recordHistory('Deselect',before,{...before,selection:null,previousSelection:selection})};
 const selectEverything=()=>commitSelection(makeSelectAll(size.w,size.h),'Select all','replace',false);
 const invertCurrentSelection=()=>commitSelection(invertSelection(selection,size.w,size.h),'Invert selection','replace',false);
 const pointFromEvent=(e:React.PointerEvent)=>point(e);
 const brushSettings=():BrushEngineSettings=>({size:brushSize,hardness,opacity,flow,spacing,smoothing,blend:brushBlend,tip:brushTip,pressureSize,pressureOpacity,pressureFlow});
 const pressureFromEvent=(e:React.PointerEvent)=>e.pointerType==='pen'&&e.pressure>0?e.pressure:1;
 const retouchPointForDocument=(point:SelectionPoint,layer:Layer,target:RetouchTarget):RetouchPoint=>target==='mask'?documentToMaskPoint(point,layer):point;
 const retouchDocumentPoint=(point:RetouchPoint,layer:Layer,target:RetouchTarget):SelectionPoint=>target==='mask'?maskToDocumentPoint(point,layer):point;
 const updateRetouchIndicator=(point:SelectionPoint)=>{
  const source=retouchSourcePoint,layer=current;if(!source||!layer||!['clone','healing'].includes(tool)){setRetouchSourceIndicator(source);return}
  const sourceTarget=retouchPointForDocument(source,layer,retouchTarget),targetPoint=retouchPointForDocument(point,layer,retouchTarget);
  const anchor=retouchStroke.current?.targetAnchor??(retouchAligned?(retouchTargetAnchor.current??targetPoint):targetPoint);
  const mapped=mapRetouchSourcePoint(targetPoint,sourceTarget,anchor,{x:retouchOffsetX,y:retouchOffsetY});
  setRetouchSourceIndicator(retouchDocumentPoint(mapped,layer,retouchTarget))
 };
 const applyRetouchSegment=(input:BrushPoint,initial=false)=>{
  const stroke=retouchStroke.current,transaction=pixelTransaction.current;if(!stroke||!transaction)return;
  const canvas=transaction.canvas,previous=brushLastPoint.current,next=smoothBrushPoint(brushSmoothedPoint.current,input,smoothing);
  const settings=brushSettings(),radius=settings.size*(settings.pressureSize?Math.max(.05,Math.max(previous.pressure,next.pressure)):1)/2+2;
  const left=Math.max(0,Math.floor(Math.min(previous.x,next.x)-radius)),top=Math.max(0,Math.floor(Math.min(previous.y,next.y)-radius));
  const right=Math.min(canvas.width,Math.ceil(Math.max(previous.x,next.x)+radius)),bottom=Math.min(canvas.height,Math.ceil(Math.max(previous.y,next.y)+radius));
  if(right<=left||bottom<=top){brushSmoothedPoint.current=next;brushLastPoint.current=next;return}
  try{
   capturePixelTiles(canvas,{left,top,right,bottom});
   const context=brushReadContext(canvas),buffer:RetouchBuffer={...context.getImageData(left,top,right-left,bottom-top),x:left,y:top};
   const sourceAt=createTiledPixelSampler(stroke.sourceCanvas.width,stroke.sourceCanvas.height,(x,y,width,height)=>{
    const key=`${x}:${y}`,cached=stroke.sourceMode==='merged'?stroke.mergedTiles.get(key):undefined;
    if(cached)return{data:cached.data,width:cached.width,height:cached.height,x,y};
    const transactionTile=pixelTransaction.current?.canvas===stroke.sourceCanvas?pixelTransaction.current.tiles.get(key):undefined;
    if(stroke.sourceMode==='merged'&&transactionTile)throw new Error('Merged source tile snapshot is unavailable after the target was edited.');
    const image=stroke.sourceMode==='active'&&transactionTile?transactionTile.before:brushReadContext(stroke.sourceCanvas).getImageData(x,y,width,height);
    return{data:image.data,width:image.width,height:image.height,x,y}
   });
   const destinationAt=createTiledPixelSampler(canvas.width,canvas.height,(x,y,width,height)=>{
    const key=`${x}:${y}`;
    const transactionTile=pixelTransaction.current?.tiles.get(key),image=transactionTile?.before??context.getImageData(x,y,width,height);
    return{data:image.data,width:image.width,height:image.height,x,y}
   });
   const maskAt=stroke.layer.mask&&stroke.target==='pixels'?createTiledPixelSampler(stroke.layer.mask.width,stroke.layer.mask.height,(x,y,width,height)=>{
    const image=brushReadContext(stroke.layer.mask!).getImageData(x,y,width,height);return{data:image.data,width:image.width,height:image.height,x,y}
   }):null;
   const coverageAt=(x:number,y:number)=>{
    const documentPoint=retouchDocumentPoint({x:x+.5,y:y+.5},stroke.layer,stroke.target);
    let coverage=selection?maskAlphaAt(selection.mask,Math.floor(documentPoint.x),Math.floor(documentPoint.y)):255;
    if(stroke.target==='pixels'&&stroke.layer.mask&&stroke.layer.maskEnabled){
     const maskPoint=documentToMaskPoint(documentPoint,stroke.layer);
     const maskPixel=maskAt?.(maskPoint.x,maskPoint.y);
     coverage=Math.round(coverage*(maskPixel?.[3]??0)/255)
    }
    return coverage
   };
   const paint=(dab:BrushPoint)=>{
    const sourceCenter=mapRetouchSourcePoint(dab,stroke.sourcePoint,stroke.targetAnchor,stroke.offset);
    applyRetouchStamp(buffer,dab,sourceCenter,sourceAt,{
     size:settings.size,hardness:settings.hardness,opacity:settings.opacity,flow:settings.flow,
     pressureSize:settings.pressureSize,pressureOpacity:settings.pressureOpacity,pressureFlow:settings.pressureFlow,
    },{kind:stroke.kind,destinationBeforeAt:destinationAt,coverageAt,maskTarget:stroke.target==='mask'})
   };
   if(initial)paint(next);
   else forEachBrushStamp(previous,next,brushSpacing.current,settings,paint);
   const output=context.createImageData(buffer.width,buffer.height);output.data.set(buffer.data);context.putImageData(output,left,top);
   if(stroke.target==='pixels')markCompositeDirty({x:left,y:top,width:right-left,height:bottom-top});
   setLayers(items=>items.map(layer=>layer.id===stroke.layer.id?{...layer}:layer));
   brushSmoothedPoint.current=next;brushLastPoint.current=next;updateRetouchIndicator({x:input.x,y:input.y})
  }catch(error){
   const activeTransaction=pixelTransaction.current;
   let rollbackError:unknown;
   try{
    if(activeTransaction){
     const rollbackContext=brushReadContext(activeTransaction.canvas);
     for(const tile of activeTransaction.tiles.values())rollbackContext.putImageData(tile.before,tile.x,tile.y);
     if(stroke.target==='pixels')markCompositeDirty({x:0,y:0,width:activeTransaction.canvas.width,height:activeTransaction.canvas.height});
     setLayers(items=>items.map(layer=>layer.id===stroke.layer.id?{...layer}:layer))
    }
   }catch(failure){rollbackError=failure}
   finally{pixelTransaction.current=null;drawingBefore.current=null;retouchStroke.current=null;drawing.current=false}
   console.error(`[PixelForge ${stroke.kind}] stroke failed`,error,rollbackError);
   announce(rollbackError?`Could not complete or roll back the ${stroke.kind==='clone'?'clone':'healing'} stroke; use Undo to restore the previous state`:`Could not complete ${stroke.kind==='clone'?'clone':'healing'} stroke: ${error instanceof Error?error.message:'canvas allocation failed'}`)
  }
 };
 const cancelRetouchStroke=()=>{
  const transaction=pixelTransaction.current,stroke=retouchStroke.current;
  let rollbackError:unknown;
  try{
   if(transaction&&stroke){
    const context=brushReadContext(transaction.canvas);
    for(const tile of transaction.tiles.values())context.putImageData(tile.before,tile.x,tile.y);
    markCompositeDirty({x:0,y:0,width:transaction.canvas.width,height:transaction.canvas.height});
    setLayers(items=>items.map(layer=>layer.id===stroke.layer.id?{...layer}:layer))
   }
  }catch(error){rollbackError=error}
  finally{pixelTransaction.current=null;drawingBefore.current=null;retouchStroke.current=null;drawing.current=false}
  if(rollbackError){console.error('[PixelForge retouch] cancellation rollback failed',rollbackError);announce('Could not roll back the retouch stroke; use Undo to restore the previous state')}
  else announce('Retouch stroke cancelled')
 };
 useEffect(()=>{
  const cancelOnEscape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&retouchStroke.current){event.preventDefault();event.stopImmediatePropagation();cancelRetouchStroke()}};
  window.addEventListener('keydown',cancelOnEscape,true);return()=>window.removeEventListener('keydown',cancelOnEscape,true)
 },[]);
 const stampBrushPath=(input:BrushPoint)=>{
  if(!current)return;
  const canvas=pixelTransaction.current?.canvas??current.canvas,settings=brushSettings(),maskStyle=tool==='mask'?maskBrushStyle(color):null;
  const paintSettings=maskStyle?{...settings,opacity:settings.opacity*maskStyle.opacityMultiplier}:settings;
  const colorValue=maskStyle?maskStyle.color:color,radius=settings.size/2+2;
  const next=smoothBrushPoint(brushSmoothedPoint.current,input,settings.smoothing);
  const bounds={left:Math.min(brushLastPoint.current.x,next.x)-radius,top:Math.min(brushLastPoint.current.y,next.y)-radius,right:Math.max(brushLastPoint.current.x,next.x)+radius,bottom:Math.max(brushLastPoint.current.y,next.y)+radius};
  capturePixelTiles(canvas,bounds);drawBrushSegment(brushReadContext(canvas),brushLastPoint.current,next,brushSpacing.current,paintSettings,colorValue,tool==='eraser'||!!maskStyle?.erase);
  brushSmoothedPoint.current=next;brushLastPoint.current=next
 };
 const textDefaults=(x:number,y:number):TextLayerData=>({content:'Text',fontFamily:'Segoe UI',fontSize:48,fontWeight:400,italic:false,alignment:'left',color,letterSpacing:0,lineSpacing:1.2,underline:false,strikethrough:false,boxWidth:Math.max(120,Math.min(600,size.w-x)),boxHeight:Math.max(100,Math.min(360,size.h-y))});
 const openTextEditor=(layer:Layer|undefined,at?:{x:number;y:number})=>{const before=captureSnapshot();if(!layer){const point=at??{x:40,y:40},data=textDefaults(point.x,point.y),created=makeLayer(1,1,'Text','text',current?.type==='group'?current.id:current?.parentId);created.x=point.x;created.y=point.y;created.width=data.boxWidth;created.height=data.boxHeight;created.textData=data;const next=[...layers,created];setLayers(next);setActive(created.id);setSelectedIds([created.id]);textEditBefore.current=before;window.setTimeout(()=>setTextEditor({layerId:created.id,data}),0);return}if(layer.type!=='text'||!layer.textData)return;textEditBefore.current=before;const data={...layer.textData};window.setTimeout(()=>setTextEditor({layerId:layer.id,data}),0)};
 const updateTextEditor=(patch:Partial<TextLayerData>)=>setTextEditor(editor=>{if(!editor)return editor;const data={...editor.data,...patch};setLayers(ls=>ls.map(layer=>layer.id===editor.layerId?{...layer,textData:data,width:patch.boxWidth??layer.width,height:patch.boxHeight??layer.height}:layer));return {...editor,data}});
 const finishTextEditor=(commit:boolean)=>{const before=textEditBefore.current;if(!before||!textEditor)return;if(commit){const after=captureSnapshot();recordHistory(before.layers.some(layer=>layer.id===textEditor!.layerId)?'Edit text':'Create text',before,after);announce('Text layer updated')}else{restoreSnapshot(before);announce('Text edit cancelled')}textEditBefore.current=null;setTextEditor(null)};
 const shapeGesture=useRef<{x:number;y:number;center:boolean}|null>(null); const shapeDraftRef=useRef<{x:number;y:number;width:number;height:number;kind:VectorShapeKind}|null>(null);
 const isShapeTool=(value:Tool):value is Extract<Tool,'rectangle'|'roundedRectangle'|'ellipse'|'line'|'polygon'|'star'>=>['rectangle','roundedRectangle','ellipse','line','polygon','star'].includes(value);
 const setShapeSettings=(patch:Partial<ShapeLayerData>)=>{const nextData={...shapeDefaults,...patch};setShapeDefaults(nextData);if(current?.type==='shape'&&current.shapeData){const before=captureSnapshot(),next=layers.map(layer=>layer.id===current.id?{...layer,shapeData:{...layer.shapeData!,...patch}}:layer);setLayers(next);recordHistory('Edit shape properties',before,{...before,layers:next})}};
 const updateTextProperties=(patch:Partial<TextLayerData>)=>{if(current?.type!=='text'||!current.textData){if(patch.color)setColor(patch.color);return}const before=captureSnapshot(),next=layers.map(layer=>layer.id===current.id?{...layer,textData:{...layer.textData!,...patch}}:layer);setLayers(next);recordHistory('Edit text properties',before,{...before,layers:next})};
 const pointerLeave=()=>{pointerUp();setBrushCursor(value=>({...value,visible:false}))};
 const resolvedGradientStops=gradientPreset==='foreground-background'?[{position:0,color,opacity:100},{position:1,color:bg,opacity:100}]:gradientPreset==='foreground-transparent'?[{position:0,color,opacity:100},{position:1,color,opacity:0}]:gradientStops;
 const canEditFillLayer=(layer:Layer|undefined):layer is Layer=>{if(!layer||layer.type!=='pixel'||!layer.visible||layer.locked)return false;let parentId=layer.parentId;while(parentId!==undefined){const parent=layers.find(item=>item.id===parentId);if(!parent||parent.type!=='group'||!parent.visible||parent.locked)return false;parentId=parent.parentId}return true};
 const fillCanvas=(layer:Layer)=>fillTarget==='mask'?layer.mask:layer.canvas;
 const selectionCoverageAt=(layer:Layer)=>(x:number,y:number)=>{if(!selection)return 255;const point=maskToDocumentPoint({x,y},layer);return maskAlphaAt(selection.mask,Math.floor(point.x),Math.floor(point.y))};
 const fillRegion=(canvas:HTMLCanvasElement,layer:Layer)=>{
  if(!selection)return{x:0,y:0,width:canvas.width,height:canvas.height};
  const bounds=selection.bounds;if(!bounds)return null;
  const corners=[{x:bounds.x,y:bounds.y},{x:bounds.x+bounds.width,y:bounds.y},{x:bounds.x,y:bounds.y+bounds.height},{x:bounds.x+bounds.width,y:bounds.y+bounds.height}].map(point=>documentToMaskPoint(point,layer));
  const x=Math.max(0,Math.floor(Math.min(...corners.map(point=>point.x)))),y=Math.max(0,Math.floor(Math.min(...corners.map(point=>point.y))));
  const right=Math.min(canvas.width,Math.ceil(Math.max(...corners.map(point=>point.x)))),bottom=Math.min(canvas.height,Math.ceil(Math.max(...corners.map(point=>point.y))));
  return right>x&&bottom>y?{x,y,width:right-x,height:bottom-y}:null
 };
 const updateFillLayer=(layer:Layer,target:'canvas'|'mask')=>setLayers(items=>items.map(item=>item.id===layer.id?{...item,...(target==='mask'?{mask:layer.mask}:{canvas:layer.canvas})}:item));
 const updateGradientStop=(index:number,patch:Partial<GradientStop>)=>{customGradientInitialized.current=true;setGradientPreset('custom');setGradientStops(items=>items.map((item,itemIndex)=>itemIndex===index?{...item,...patch}:item).sort((a,b)=>a.position-b.position))};
 const addGradientStop=()=>{customGradientInitialized.current=true;setGradientPreset('custom');setGradientStops(items=>{if(items.length>=16)return items;const sorted=[...items].sort((a,b)=>a.position-b.position),position=sorted.slice(0,-1).reduce((best,item,index)=>{const gap=sorted[index+1].position-item.position;return gap>best.gap?{gap,position:(item.position+sorted[index+1].position)/2}:best},{gap:-1,position:.5}).position;return [...items,{position,color,opacity:100}].sort((a,b)=>a.position-b.position)})};
 const rollbackFillTransaction=()=>{const transaction=pixelTransaction.current;let failed=false;try{if(transaction){const context=brushReadContext(transaction.canvas);for(const tile of transaction.tiles.values())context.putImageData(tile.before,tile.x,tile.y)}}catch(error){failed=true;console.error('[PixelForge fill] rollback failed',error)}finally{pixelTransaction.current=null;drawingBefore.current=null}return failed};
 const handleFillFailure=(operation:string,error:unknown)=>{if(rollbackFillTransaction()){console.error(`[PixelForge ${operation}] operation failed`,error);announce(`${operation==='apply gradient'?'Gradient':'Flood fill'} failed and rollback could not complete; use Undo to restore the previous state`)}else reportOperationFailure(operation,error)};
 const commitGradient=(documentEnd:SelectionPoint)=>{
  const layer=current;if(!canEditFillLayer(layer)){announce('Select a visible, unlocked raster layer to apply a gradient');return}
  const target=fillTarget==='mask'?'mask':'canvas',canvas=fillCanvas(layer);if(!canvas){announce('Add a layer mask before editing mask contents');return}
  const region=fillRegion(canvas,layer);if(!region){announce('The current selection has no fillable area');return}
  try{
   const context=brushReadContext(canvas),image=context.getImageData(region.x,region.y,region.width,region.height),localStart=documentToMaskPoint(start.current,layer),localEnd=documentToMaskPoint(documentEnd,layer),before=drawingBefore.current??captureSnapshot();
   applyGradientPixels(image.data,region.width,region.height,{kind:gradientKind,start:localStart,end:localEnd,stops:resolvedGradientStops,opacity:fillOpacity,blend:fillBlend,originX:region.x,originY:region.y,coverageAt:selection?selectionCoverageAt(layer):undefined,targetMask:target==='mask'});
   beginPixelTransaction(layer.id,target,canvas);drawingBefore.current=before;capturePixelTiles(canvas,{left:region.x,top:region.y,right:region.x+region.width,bottom:region.y+region.height});context.putImageData(image,region.x,region.y);
   if(target==='canvas')markCompositeDirty(region);updateFillLayer(layer,target);finishPixelTransaction(false,true,'Apply gradient')
  }catch(error){handleFillFailure('apply gradient',error)}
 };
 const applyFloodFill=(documentPoint:SelectionPoint)=>{
  const layer=current;if(!canEditFillLayer(layer)){announce('Select a visible, unlocked raster layer to use flood fill');return}
  const target=fillTarget==='mask'?'mask':'canvas',canvas=fillCanvas(layer);if(!canvas){announce('Add a layer mask before editing mask contents');return}
  try{
   const context=brushReadContext(canvas),image=context.getImageData(0,0,canvas.width,canvas.height),seed=documentToMaskPoint(documentPoint,layer);
   const result=floodFillPixels(image.data,canvas.width,canvas.height,{x:seed.x,y:seed.y,tolerance:floodTolerance,contiguous:floodContiguous,antiAlias:floodAntiAlias});
   if(!result.bounds||!result.count){announce('No matching pixels found');return}
   const source=fillSource==='foreground'?color:bg,before=captureSnapshot();
   beginPixelTransaction(layer.id,target,canvas);drawingBefore.current=before;capturePixelTiles(canvas,{left:result.bounds.x,top:result.bounds.y,right:result.bounds.x+result.bounds.width,bottom:result.bounds.y+result.bounds.height});
   applyFloodFillPixels(image.data,result,source,fillOpacity,fillBlend,selection?selectionCoverageAt(layer):undefined,target==='mask');
   context.putImageData(image,0,0,result.bounds.x,result.bounds.y,result.bounds.width,result.bounds.height);
   if(target==='canvas')markCompositeDirty(result.bounds);updateFillLayer(layer,target);finishPixelTransaction(false,true,'Flood fill')
  }catch(error){handleFillFailure('flood fill',error)}
 };
 const beginRetouchStroke=(e:React.PointerEvent,p:SelectionPoint)=>{
  const layer=current;
  if(!canEditFillLayer(layer)){announce('Select a visible, unlocked raster layer to retouch');return}
  if(e.altKey){
   setRetouchSourcePoint(p);setRetouchSourceIndicator(p);retouchTargetAnchor.current=null;announce('Retouch source point set');return
  }
  if(!retouchSourcePoint){announce('Alt-click the canvas to choose a retouch source point');return}
  if(retouchTarget==='mask'&&!layer.mask){announce('Add a layer mask before retouching mask contents');return}
  const targetCanvas=retouchTarget==='mask'?layer.mask:layer.canvas;
  if(!targetCanvas){announce('The selected retouch target is unavailable');return}
  const sourceMode:RetouchSourceMode=retouchTarget==='mask'?'active':retouchSourceMode;
  const sourceCanvas=sourceMode==='merged'?viewRef.current:targetCanvas;
  if(!sourceCanvas){announce('The merged image is unavailable for sampling');return}
  const targetPoint=retouchPointForDocument(p,layer,retouchTarget);
  if(retouchAligned&&!retouchTargetAnchor.current)retouchTargetAnchor.current={...targetPoint};
  const targetAnchor=retouchAligned?retouchTargetAnchor.current!:{...targetPoint};
  const sourcePoint=retouchPointForDocument(retouchSourcePoint,layer,retouchTarget);
  const kind:RetouchKind=tool==='clone'?'clone':'healing';
  drawingBefore.current=captureSnapshot();beginPixelTransaction(layer.id,retouchTarget==='mask'?'mask':'canvas',targetCanvas);
  retouchStroke.current={
   kind,sourceMode,sourceCanvas,sourcePoint,targetAnchor,
   offset:{x:retouchOffsetX,y:retouchOffsetY},target:retouchTarget,
   mergedTiles:new Map(),layer,
  };
  start.current=targetPoint;last.current=targetPoint;drawing.current=true;
  brushLastPoint.current={...targetPoint,pressure:pressureFromEvent(e)};brushSmoothedPoint.current=brushLastPoint.current;brushSpacing.current={distanceSinceStamp:0};
  updateRetouchIndicator(p);(e.target as HTMLElement).setPointerCapture(e.pointerId);
  applyRetouchSegment(brushLastPoint.current,true)
 };
 const pointerDown=(e:React.PointerEvent)=>{
  const p=pointFromEvent(e);
  if(tool==='crop'){beginCrop(p);(e.target as HTMLElement).setPointerCapture(e.pointerId);return}
  if(tool==='move'&&current&&current.type!=='adjustment'&&!current.locked){transformBefore.current=captureSnapshot();transformAction.current=Math.hypot(p.x-(current.x+current.width),p.y-(current.y+current.height))<14/Math.max(.1,zoom/100)?'resize':'move';start.current=p;last.current=p;drawing.current=true;(e.target as HTMLElement).setPointerCapture(e.pointerId);return}
  if(tool==='fill'){applyFloodFill(p);return}
  if(tool==='clone'||tool==='healing'){beginRetouchStroke(e,p);return}
  if(tool==='gradient'){
   if(!canEditFillLayer(current)){announce('Select a visible, unlocked raster layer to apply a gradient');return}
   if(fillTarget==='mask'&&!current.mask){announce('Add a layer mask before editing mask contents');return}
   start.current=p;last.current=p;drawing.current=true;drawingBefore.current=captureSnapshot();setGradientPreview({start:p,end:p});(e.target as HTMLElement).setPointerCapture(e.pointerId);return
  }
  if(tool==='polygonLasso'){if(polygonPoints.length>=3&&Math.hypot(p.x-polygonPoints[0].x,p.y-polygonPoints[0].y)<8){commitSelection(rasterizeSelection(size.w,size.h,'polygon',polygonPoints[0],polygonPoints.at(-1)!,polygonPoints,selectionAA),'Polygon selection');setPolygonPoints([]);return}setPolygonPoints(points=>[...points,p]);setPolygonCursor(p);return}
  if(isShapeTool(tool)){const layerTool=tool;shapeGesture.current={x:p.x,y:p.y,center:e.altKey};start.current=p;drawing.current=true;drawingBefore.current=captureSnapshot();shapeDraftRef.current={x:p.x,y:p.y,width:1,height:1,kind:layerTool};setShapeDraft(shapeDraftRef.current);(e.target as HTMLElement).setPointerCapture(e.pointerId);return}
  if(tool==='text'){openTextEditor(current?.type==='text'?current:undefined,p);return}
  if(tool==='wand'){if(!viewRef.current)return;const source=wandSampleMerged?viewRef.current:current?.canvas;if(!source)return;try{const mask=colorSelection(source.getContext('2d',{willReadFrequently:true})!.getImageData(0,0,size.w,size.h),p,wandTolerance,wandContiguous,selectionAA);commitSelection(mask,'Magic wand selection',e.altKey?'subtract':e.shiftKey?'add':selectionMode)}catch(error){console.error('[PixelForge selection] sample failed',error);announce('Could not sample image pixels')}return}
  if(['marquee','ellipseSelect','rowSelect','columnSelect','lasso'].includes(tool)){selectionGestureMode.current=e.altKey?'subtract':e.shiftKey?'add':selectionMode;selectionOrigin.current=selection;movingSelection.current=!!selection&&selectionGestureMode.current==='replace'&&maskAlphaAt(selection.mask,Math.floor(p.x),Math.floor(p.y))>0;start.current=p;last.current=p;pathPoints.current=[p];setSelectionPreview(null);drawing.current=true;(e.target as HTMLElement).setPointerCapture(e.pointerId);return}
  if(!current||current.type==='group'||current.locked||tool==='hand'||(tool!=='mask'&&current.type!=='pixel'))return;
  const paintPoint=tool==='mask'?documentToMaskPoint(p,current):p;
  start.current=paintPoint;last.current=paintPoint;drawing.current=true;(e.target as HTMLElement).setPointerCapture(e.pointerId);drawingBefore.current=captureSnapshot();
  if(tool==='mask'&&!current.mask){
   const width=Math.max(1,Math.round(current.type==='pixel'?current.canvas.width:current.width)),height=Math.max(1,Math.round(current.type==='pixel'?current.canvas.height:current.height));let mask:HTMLCanvasElement;
   try{mask=mkCanvas(width,height);const maskCtx=mask.getContext('2d')!;maskCtx.fillStyle='#ffffff';maskCtx.fillRect(0,0,width,height)}
   catch(error){drawing.current=false;drawingBefore.current=null;reportOperationFailure('create layer mask',error);return}
   setLayers(items=>items.map(layer=>layer.id===current.id?{...layer,mask,maskEnabled:true,maskMode:'alpha' as const}:layer));beginPixelTransaction(current.id,'mask',mask);
   brushLastPoint.current={...paintPoint,pressure:pressureFromEvent(e)};brushSmoothedPoint.current=brushLastPoint.current;brushSpacing.current={distanceSinceStamp:0};
   const radius=brushSize/2+2,style=maskBrushStyle(color),settings=brushSettings();
   capturePixelTiles(mask,{left:paintPoint.x-radius,top:paintPoint.y-radius,right:paintPoint.x+radius,bottom:paintPoint.y+radius});
   drawBrushDot(brushReadContext(mask),brushLastPoint.current,{...settings,opacity:settings.opacity*style.opacityMultiplier},style.color,style.erase);return
  }
  const paintCanvas=tool==='mask'?current.mask!:current.canvas;
  beginPixelTransaction(current.id,tool==='mask'?'mask':'canvas',paintCanvas);brushLastPoint.current={...paintPoint,pressure:pressureFromEvent(e)};brushSmoothedPoint.current=brushLastPoint.current;brushSpacing.current={distanceSinceStamp:0};
  if(tool==='move'){snapshot.current=current.canvas.getContext('2d')!.getImageData(0,0,size.w,size.h);capturePixelTiles(paintCanvas,{left:0,top:0,right:size.w,bottom:size.h});return}
  const brushCanvas=pixelTransaction.current?.canvas??paintCanvas,radius=brushSize/2+2,style=tool==='mask'?maskBrushStyle(color):null,settings=brushSettings();
  capturePixelTiles(brushCanvas,{left:paintPoint.x-radius,top:paintPoint.y-radius,right:paintPoint.x+radius,bottom:paintPoint.y+radius});
  if(tool!=='mask'){const margin=brushSize/2+(hardness<100?(100-hardness)/16:0)+3;markCompositeDirty({x:paintPoint.x-margin,y:paintPoint.y-margin,width:margin*2,height:margin*2})}
  drawBrushDot(brushReadContext(brushCanvas),brushLastPoint.current,style?{...settings,opacity:settings.opacity*style.opacityMultiplier}:settings,style?style.color:color,tool==='eraser'||!!style?.erase)
 };
 const dab=(p:{x:number,y:number},from:{x:number,y:number})=>{if(!current)return;const transaction=pixelTransaction.current,canvas=transaction?.canvas??current.canvas,ctx=canvas.getContext('2d')!,margin=brushSize/2+(hardness<100?(100-hardness)/16:0)+2,x=Math.max(0,Math.floor(Math.min(from.x,p.x)-margin)),y=Math.max(0,Math.floor(Math.min(from.y,p.y)-margin)),right=Math.min(size.w,Math.ceil(Math.max(from.x,p.x)+margin)),bottom=Math.min(size.h,Math.ceil(Math.max(from.y,p.y)+margin));capturePixelTiles(canvas,{left:x,top:y,right,bottom});const before=ctx.getImageData(x,y,right-x,bottom-y);ctx.save();ctx.globalAlpha=opacity/100;ctx.globalCompositeOperation=tool==='eraser'?'destination-out':'source-over';ctx.strokeStyle=tool==='mask'?'#000':color;ctx.fillStyle=tool==='mask'?'#000':color;ctx.lineCap='round';ctx.lineJoin='round';ctx.lineWidth=brushSize;ctx.filter=hardness<100?`blur(${(100-hardness)/16}px)`:'none';ctx.beginPath();ctx.moveTo(from.x,from.y);ctx.lineTo(p.x,p.y);ctx.stroke();ctx.beginPath();ctx.arc(p.x,p.y,brushSize/2,0,Math.PI*2);ctx.fill();ctx.restore();applySelectionPixels(canvas,before,{x,y,width:right-x,height:bottom-y})};
 const pointerMove=(e:React.PointerEvent)=>{
  const p=point(e);setBrushCursor({x:p.x,y:p.y,visible:['brush','eraser','mask','clone','healing'].includes(tool),pressure:pressureFromEvent(e)});
  if(tool==='clone'||tool==='healing')updateRetouchIndicator(p);
  if(tool==='polygonLasso'){setPolygonCursor(p);return}
  if(movingSelection.current&&drawing.current&&selectionOrigin.current){last.current=p;setSelectionPreview(translateSelection(selectionOrigin.current,p.x-start.current.x,p.y-start.current.y));return}
  if(tool==='lasso'&&drawing.current){pathPoints.current.push(p);return}
  if(!drawing.current)return;
  if(tool==='gradient'){last.current=p;setGradientPreview({start:start.current,end:p});return}
  if(tool==='clone'||tool==='healing'){
   const native=e.nativeEvent as PointerEvent&{getCoalescedEvents?:()=>PointerEvent[]},coalesced=native.getCoalescedEvents?.()??[],samples=coalesced.length?coalesced:[native];
   for(const sample of samples){const rect=viewRef.current!.getBoundingClientRect(),documentPoint={x:(sample.clientX-rect.left)*size.w/rect.width,y:(sample.clientY-rect.top)*size.h/rect.height},stroke=retouchStroke.current,targetPoint=stroke?retouchPointForDocument(documentPoint,stroke.layer,stroke.target):documentPoint;applyRetouchSegment({...targetPoint,pressure:sample.pointerType==='pen'&&sample.pressure>0?sample.pressure:1})}
   last.current=p;return
  }
  if(isShapeTool(tool)){const origin=shapeGesture.current;if(!origin)return;let dx=p.x-origin.x,dy=p.y-origin.y;if(e.shiftKey){const side=Math.max(Math.abs(dx),Math.abs(dy));dx=Math.sign(dx||1)*side;dy=Math.sign(dy||1)*side}const x=origin.center?origin.x-Math.abs(dx):Math.min(origin.x,origin.x+dx),y=origin.center?origin.y-Math.abs(dy):Math.min(origin.y,origin.y+dy),width=Math.max(1,Math.abs(dx)*(origin.center?2:1)),height=Math.max(1,Math.abs(dy)*(origin.center?2:1));shapeDraftRef.current={x,y,width,height,kind:tool};setShapeDraft(shapeDraftRef.current);last.current=p;return}
  if(tool==='crop'){const origin=cropOrigin.current;if(cropAction.current==='draw'){let x=Math.min(start.current.x,p.x),y=Math.min(start.current.y,p.y),rect=cropConstrain({x,y,width:Math.abs(p.x-start.current.x),height:Math.abs(p.y-start.current.y)});if(e.shiftKey){const side=Math.max(rect.width,rect.height);rect={...rect,width:side,height:side}}setCropRect(rect)}else if(origin){if(cropAction.current==='move')setCropRect({...origin,x:origin.x+p.x-start.current.x,y:origin.y+p.y-start.current.y});else{let x=origin.x,y=origin.y,w=origin.width,h=origin.height;if(cropAction.current.includes('e'))w=Math.max(1,origin.width+p.x-start.current.x);if(cropAction.current.includes('s'))h=Math.max(1,origin.height+p.y-start.current.y);if(cropAction.current.includes('w')){x=origin.x+p.x-start.current.x;w=Math.max(1,origin.width-(x-origin.x))}if(cropAction.current.includes('n')){y=origin.y+p.y-start.current.y;h=Math.max(1,origin.height-(y-origin.y))}setCropRect(cropConstrain({x,y,width:w,height:h}))}}return}
  if(tool==='move'&&current){const dx=p.x-start.current.x,dy=p.y-start.current.y;setLayers(ls=>ls.map(layer=>layer.id===current.id?(transformAction.current==='resize'?{...layer,width:Math.max(1,layer.width+dx),height:Math.max(1,layer.height+(e.shiftKey?dx*layer.height/Math.max(1,layer.width):dy))}:{...layer,x:(layer.x||0)+dx,y:(layer.y||0)+dy}):layer));start.current=p;return}
  if(['marquee','ellipseSelect','rowSelect','columnSelect'].includes(tool)){const kind:ShapeKind=tool==='marquee'?'rect':tool==='ellipseSelect'?'ellipse':tool==='rowSelect'?'row':'column';last.current=p;const incoming=rasterizeSelection(size.w,size.h,kind,start.current,p,[],selectionAA);setSelectionPreview(combineSelection(selection,incoming,selectionGestureMode.current));return}
  if(!current)return;
  if(tool==='move'){const temp=mkCanvas(size.w,size.h);temp.getContext('2d')!.putImageData(snapshot.current!,0,0);const c=current.canvas.getContext('2d')!;c.clearRect(0,0,size.w,size.h);c.drawImage(temp,p.x-start.current.x,p.y-start.current.y);capturePixelTiles(current.canvas,{left:0,top:0,right:size.w,bottom:size.h});setLayers(ls=>ls.map(l=>l.id===current.id?{...l}:l));return}
  const native=e.nativeEvent as PointerEvent&{getCoalescedEvents?:()=>PointerEvent[]};const coalesced=native.getCoalescedEvents?.()??[],samples=coalesced.length?coalesced:[native];
  for(const sample of samples){const rect=viewRef.current!.getBoundingClientRect(),raw:BrushPoint={x:(sample.clientX-rect.left)*size.w/rect.width,y:(sample.clientY-rect.top)*size.h/rect.height,pressure:sample.pointerType==='pen'&&sample.pressure>0?sample.pressure:1};if(tool!=='mask'){const previous=brushLastPoint.current,margin=brushSize/2+(hardness<100?(100-hardness)/16:0)+3,left=Math.min(previous.x,raw.x)-margin,top=Math.min(previous.y,raw.y)-margin,right=Math.max(previous.x,raw.x)+margin,bottom=Math.max(previous.y,raw.y)+margin;markCompositeDirty({x:left,y:top,width:right-left,height:bottom-top})}stampBrushPath(tool==='mask'?{...raw,...documentToMaskPoint(raw,current)}:raw)}
  last.current=p;setLayers(ls=>ls.map(l=>l.id===active?{...l}:l))
 };
 const pointerUp=(event?:React.PointerEvent)=>{
  if(!drawing.current)return;
  if(tool==='crop'){drawing.current=false;return}
  if(tool==='gradient'){const end=event?pointFromEvent(event):last.current;last.current=end;drawing.current=false;setGradientPreview(null);commitGradient(end);return}
  const draft=shapeDraftRef.current;
  if(isShapeTool(tool)&&draft){
   const before=drawingBefore.current??captureSnapshot(),w=Math.max(1,draft.width),h=Math.max(1,draft.height),created=makeLayer(1,1,`${draft.kind.replace(/[A-Z]/g,m=>` ${m.toLowerCase()}`)} shape`,'shape',current?.type==='group'?current.id:current?.parentId);
   created.x=draft.x;created.y=draft.y;created.width=w;created.height=h;
   created.shapeData={...shapeDefaults,kind:draft.kind,...(draft.kind==='line'&&shapeGesture.current?{lineStart:{x:start.current.x-draft.x,y:start.current.y-draft.y},lineEnd:{x:last.current.x-draft.x,y:last.current.y-draft.y}}:{})};
   const next=[...layers,created];setLayers(next);setActive(created.id);setSelectedIds([created.id]);setShapeDraft(null);shapeDraftRef.current=null;shapeGesture.current=null;drawing.current=false;drawingBefore.current=null;
   recordHistory('Create shape',before,{...before,layers:next,activeLayerId:created.id,selectedLayerIds:[created.id]});announce('Editable shape layer created');return
  }
  if(tool==='move'&&transformBefore.current&&current){
   const before=transformBefore.current;transformBefore.current=null;drawing.current=false;const after=captureSnapshot();
   if(before.layers.some((layer,index)=>['x','y','width','height','rotation'].some(key=>layer[key as keyof Layer]!==after.layers[index]?.[key as keyof Layer])))recordHistory('Transform layer',before,after);
   return
  }
  if(event&&['brush','eraser','mask','clone','healing'].includes(tool)&&viewRef.current){
   const rect=viewRef.current.getBoundingClientRect(),documentPoint={x:(event.clientX-rect.left)*size.w/rect.width,y:(event.clientY-rect.top)*size.h/rect.height},stroke=retouchStroke.current,raw:BrushPoint={...(stroke?retouchPointForDocument(documentPoint,stroke.layer,stroke.target):documentPoint),pressure:pressureFromEvent(event)};
   if(tool==='clone'||tool==='healing')applyRetouchSegment(raw);
   else{
    if(tool!=='mask'&&current){const previous=brushLastPoint.current,margin=brushSize/2+(hardness<100?(100-hardness)/16:0)+3,left=Math.min(previous.x,raw.x)-margin,top=Math.min(previous.y,raw.y)-margin,right=Math.max(previous.x,raw.x)+margin,bottom=Math.max(previous.y,raw.y)+margin;markCompositeDirty({x:left,y:top,width:right-left,height:bottom-top})}
    stampBrushPath(tool==='mask'&&current?{...raw,...documentToMaskPoint(raw,current)}:raw)
   }
  }
  if(['marquee','ellipseSelect','rowSelect','columnSelect','lasso'].includes(tool)){
   if(movingSelection.current){if(selectionPreview)commitSelection(selectionPreview,'Move selection','replace',false);setSelectionPreview(null);movingSelection.current=false;selectionOrigin.current=null;drawing.current=false;return}
   let incoming:SelectionState;
   if(tool==='lasso'){
    const points=pathPoints.current;if(points.length<3){drawing.current=false;return}
    incoming=rasterizeSelection(size.w,size.h,'polygon',points[0],points.at(-1)!,points,selectionAA)
   }else{
    const kind:ShapeKind=tool==='marquee'?'rect':tool==='ellipseSelect'?'ellipse':tool==='rowSelect'?'row':'column';
    incoming=rasterizeSelection(size.w,size.h,kind,start.current,last.current,[],selectionAA)
   }
   setSelectionPreview(null);commitSelection(incoming,tool==='lasso'?'Freehand lasso':'Marquee selection',selectionGestureMode.current);pathPoints.current=[]
  }else if(pixelTransaction.current){
   if(retouchStroke.current){const kind=retouchStroke.current.kind;finishPixelTransaction(false,true,kind==='clone'?'Clone stamp stroke':'Healing brush stroke');retouchStroke.current=null}
   else finishPixelTransaction()
  }
  drawing.current=false
 };
 useEffect(()=>{
  const canvas=viewRef.current;if(!canvas)return;
  const cancel=()=>{if(retouchStroke.current)cancelRetouchStroke()};
  canvas.addEventListener('pointercancel',cancel);return()=>canvas.removeEventListener('pointercancel',cancel)
 },[]);
 const addLayer=()=>{try{const before=captureSnapshot(),parent=current?.type==='group'?current.id:current?.parentId,l=makeLayer(size.w,size.h,`Layer ${layers.length+1}`,'pixel',parent),next=[...layers,l];setLayers(next);setActive(l.id);setSelectedIds([l.id]);recordHistory('Create layer',before,{...before,layers:next,activeLayerId:l.id,selectedLayerIds:[l.id]});announce('New layer created')}catch(error){reportOperationFailure('create layer',error)}};
 const duplicateActiveLayer=()=>{if(!current)return;try{const before=captureSnapshot();if(current.type==='group'){const duplicated=duplicateLayerTree(layers,current.id);if(!duplicated)return;setLayers(duplicated.layers);setActive(duplicated.duplicatedId);setSelectedIds([duplicated.duplicatedId]);recordHistory('Duplicate group',before,{...before,layers:duplicated.layers,activeLayerId:duplicated.duplicatedId,selectedLayerIds:[duplicated.duplicatedId]});announce('Group duplicated');return}const copy=duplicateLayerModel(layers,current.id);if(!copy)return;const index=layers.findIndex(layer=>layer.id===current.id),next=[...layers];next.splice(index+1,0,copy);setLayers(next);setActive(copy.id);setSelectedIds([copy.id]);recordHistory('Duplicate layer',before,{...before,layers:next,activeLayerId:copy.id,selectedLayerIds:[copy.id]});announce('Layer duplicated')}catch(error){reportOperationFailure('duplicate layer',error)}};
  const deleteActiveLayer=()=>{const deleted=current;if(!deleted)return;const deletedId=deleted.id,parentId=deleted.parentId;if(layers.filter(layer=>layer.parentId===parentId).length<2&&deleted.type!=='group')return announce('Keep at least one layer in this group');const before=captureSnapshot(),next=layers.filter(layer=>layer.id!==deletedId&&!isDescendantOf(layer,deletedId,layers)),siblings=next.filter(layer=>layer.parentId===parentId),nextActive=siblings[siblings.length-1]??next[next.length-1];if(!nextActive)return announce('Keep at least one layer');setLayers(next);setActive(nextActive.id);setSelectedIds([nextActive.id]);recordHistory('Delete layer',before,{...before,layers:next,activeLayerId:nextActive.id,selectedLayerIds:[nextActive.id]});announce('Layer deleted')};
 const renameLayer=(id:number,name:string)=>{const layer=layers.find(item=>item.id===id);if(!layer||!name.trim()||name.trim()===layer.name)return;const before=captureSnapshot(),next=layers.map(item=>item.id===id?{...item,name:name.trim()}:item);setLayers(next);recordHistory('Rename layer',before,{...before,layers:next})};
 const changeLayerOrder=(id:number,direction:-1|1)=>{const before=captureSnapshot(),next=reorderLayer(layers,id,direction);if(!next)return;setLayers(next);setActive(id);recordHistory(direction===1?'Move layer up':'Move layer down',before,{...before,layers:next,activeLayerId:id})};
 const moveLayerInTree=(id:number,parentId:number|undefined,index:number)=>{
  const next=moveLayer(layers,id,parentId,index);
  if(!next){announce('That layer move would create an invalid group hierarchy');return}
  if(layers.length===next.length&&layers.every((layer,i)=>layer.id===next[i].id&&layer.parentId===next[i].parentId))return;
  const before=captureSnapshot();setLayers(next);setActive(id);setSelectedIds([id]);recordHistory('Move layer',before,{...before,layers:next,activeLayerId:id,selectedLayerIds:[id]})
 };
 const mergeSelectedLayers=()=>{
  const selected=new Set(selectedIds),chosen=layers.filter(layer=>selected.has(layer.id));
  if(chosen.length<2||chosen.length!==selected.size){announce('Select at least two adjacent layers to merge');return}
  if(chosen.some(layer=>layer.type==='adjustment')){announce('Adjustment layers cannot be merged with raster layers');return}
  if(chosen.some(layer=>layer.type==='group'||!layer.visible||layer.locked||layer.opacity!==100||layer.blend!=='source-over'||layer.filter!=='none')){announce('Merge requires visible, unlocked sibling layers with normal blend and full opacity');return}
  const parentId=chosen[0].parentId;
  if(chosen.some(layer=>layer.parentId!==parentId)){announce('Merge only supports sibling layers');return}
  const siblings=layers.filter(layer=>layer.parentId===parentId),siblingIndexes=chosen.map(layer=>siblings.findIndex(item=>item.id===layer.id)).sort((a,b)=>a-b);
  if(siblingIndexes.some((index,i)=>i>0&&index!==siblingIndexes[i-1]+1)){announce('Select adjacent sibling layers to merge');return}
  try{
  const before=captureSnapshot(),flattened=mkCanvas(size.w,size.h),mergedContext=flattened.getContext('2d')!;
  for(const layer of chosen){
   const surface=mkCanvas(size.w,size.h),context=surface.getContext('2d')!,width=layer.width||layer.canvas.width,height=layer.height||layer.canvas.height;
   context.save();context.filter=layer.filter;context.translate(layer.x+width/2,layer.y+height/2);context.rotate((layer.rotation||0)*Math.PI/180);
   if(layer.flipX||layer.flipY)context.scale(layer.flipX?-1:1,layer.flipY?-1:1);
   if(layer.type==='text'||layer.type==='shape'){context.translate(-width/2,-height/2);drawVectorLayer(context,layer)}else context.drawImage(layer.canvas,-width/2,-height/2,width,height);
   context.restore();
   if(layer.effects.some(effect=>effect.enabled)){const source=context.getImageData(0,0,size.w,size.h),pixels=applyEffectStack(source.data,size.w,size.h,layer.effects),result=context.createImageData(size.w,size.h);result.data.set(pixels);context.putImageData(result,0,0)}
   if(layer.mask&&layer.maskEnabled){context.save();context.filter='none';context.globalCompositeOperation='destination-in';context.translate(layer.x+width/2,layer.y+height/2);context.rotate((layer.rotation||0)*Math.PI/180);if(layer.flipX||layer.flipY)context.scale(layer.flipX?-1:1,layer.flipY?-1:1);context.drawImage(layer.mask,-width/2,-height/2,width,height);context.restore()}
   mergedContext.drawImage(surface,0,0)
  }
  const merged=makeLayer(1,1,'Merged layers','pixel',parentId);merged.canvas=flattened;merged.width=size.w;merged.height=size.h;
  const next=mergeLayerSelection(layers,selectedIds,merged);
  if(!next){announce('Select adjacent sibling layers to merge');return}
  setLayers(next);setActive(merged.id);setSelectedIds([merged.id]);recordHistory('Merge layers',before,{...before,layers:next,activeLayerId:merged.id,selectedLayerIds:[merged.id]});announce('Layers merged')
  }catch(error){reportOperationFailure('merge layers',error)}
 };
 const groupSelectedLayers=()=>{const before=captureSnapshot(),groupId=Date.now()+Math.random(),next=groupLayers(layers,selectedIds,groupId);if(!next)return announce('Select a contiguous set of sibling layers to group');const group=next.find(layer=>layer.id===groupId)!;const sized=next.map(layer=>layer.id===groupId?{...layer,width:size.w,height:size.h}:layer);setLayers(sized);setActive(group.id);setSelectedIds([group.id]);recordHistory('Group layers',before,{...before,layers:sized,activeLayerId:group.id,selectedLayerIds:[group.id]});announce('Layers grouped')};
 const ungroupActiveLayer=()=>{if(!current||current.type!=='group')return;const before=captureSnapshot(),next=ungroupLayer(layers,current.id);if(!next)return;const children=layers.filter(layer=>layer.parentId===current.id);const activeChild=children.at(-1);setLayers(next);if(activeChild){setActive(activeChild.id);setSelectedIds([activeChild.id])}recordHistory('Ungroup layers',before,{...before,layers:next,activeLayerId:activeChild?.id??active,selectedLayerIds:activeChild?[activeChild.id]:selectedIds});announce('Group released')};
 const toggleGroup=(id:number)=>setLayers(prev=>prev.map(layer=>layer.id===id?{...layer,expanded:!layer.expanded}:layer));
 const isDescendantOf=(layer:Layer,ancestorId:number,all:Layer[]):boolean=>{let parent=layer.parentId;while(parent!==undefined){if(parent===ancestorId)return true;parent=all.find(item=>item.id===parent)?.parentId}return false};
 const selectLayer=(id:number,e:React.MouseEvent)=>{if(tool==='mask')setTool('brush');if(e.ctrlKey||e.metaKey){setSelectedIds(ids=>ids.includes(id)?ids.filter(item=>item!==id):[...ids,id]);setActive(id);return}if(e.shiftKey){const siblings=layers.filter(layer=>layer.parentId===layers.find(item=>item.id===active)?.parentId),a=siblings.findIndex(layer=>layer.id===active),b=siblings.findIndex(layer=>layer.id===id);setSelectedIds(siblings.slice(Math.min(a,b),Math.max(a,b)+1).map(layer=>layer.id));setActive(id);return}setSelectedIds([id]);setActive(id)};
 const activateDocument=(doc:DocumentModel)=>{finishPropertyGesture();setCropRect(null);historyRef.current={documentId:doc.id,history:doc.history};setHistoryLimit(doc.history.limit);setActiveDocumentId(doc.id);setTitle(doc.name);setSize({...doc.size});setLayers(doc.layers);setActive(doc.activeLayerId);setSelectedIds([...doc.selectedLayerIds]);setSelection(doc.selection);setPreviousSelection(doc.previousSelection);setPaths(doc.paths.map(path=>({...path,subpaths:path.subpaths.map(subpath=>({...subpath,points:subpath.points.map(point=>({...point}))}))})));setActivePathId(doc.activePathId);setChannelView(doc.channelView);setAdjust({...doc.adjustments});setBg(doc.background);setZoom(doc.zoom);setRenaming(false);setRenamingLayerId(null);setRenamingPathId(null)};
 const commitPathChange=(label:string,next:VectorPath[],nextActivePathId:string|null,before=captureSnapshot())=>{const snapshotPaths=next.map(path=>({...path,subpaths:path.subpaths.map(subpath=>({...subpath,points:subpath.points.map(point=>({...point}))}))}));setPaths(next);setActivePathId(nextActivePathId);recordHistory(label,before,{...before,paths:snapshotPaths,activePathId:nextActivePathId})};
 const createPath=()=>{try{const path=createVectorPath(`Work Path ${paths.length+1}`);commitPathChange('Create path',[...paths,path],path.id);setActivePanel('Paths');announce('Path created')}catch(error){announce(error instanceof Error?error.message:'Could not create path')}};
 const addSelectionToPath=()=>{if(!selection){announce('Create a selection before converting it to a path');return}try{const before=captureSnapshot(),subpaths=selectionToSubpaths(selection),added=appendSubpathsToPath(paths,activePathId,subpaths,`Work Path ${paths.length+1}`);commitPathChange('Add selection to path',added.paths,added.pathId,before);setActivePanel('Paths');announce('Selection added to path')}catch(error){console.error('[PixelForge paths] selection conversion failed',error);announce(error instanceof Error?error.message:'Could not convert selection to a path')}};
 const addShapeToPath=()=>{if(!current||!supportsPathFromLayer(current)){announce('Select a supported vector shape layer first');return}try{const subpaths=shapeLayerToSubpaths(current);if(!subpaths)throw new Error('The selected layer cannot be converted to a path.');const before=captureSnapshot(),added=appendSubpathsToPath(paths,activePathId,subpaths,`${current.name} Path`);commitPathChange('Add shape to path',added.paths,added.pathId,before);setActivePanel('Paths');announce('Shape outline added to path')}catch(error){console.error('[PixelForge paths] shape conversion failed',error);announce(error instanceof Error?error.message:'Could not convert shape to a path')}};
 const renamePath=(pathId:string,name:string)=>{try{const before=captureSnapshot(),next=renameVectorPath(paths,pathId,name);if(next.find(path=>path.id===pathId)?.name===paths.find(path=>path.id===pathId)?.name)return;commitPathChange('Rename path',next,activePathId,before)}catch(error){announce(error instanceof Error?error.message:'Could not rename path')}};
 const togglePathVisibility=(path:VectorPath)=>{const before=captureSnapshot(),next=setVectorPathVisibility(paths,path.id,!path.visible);commitPathChange(path.visible?'Hide path':'Show path',next,activePathId,before)};
 const removePath=(pathId:string)=>{const index=paths.findIndex(path=>path.id===pathId);if(index<0)return;const next=deleteVectorPath(paths,pathId),nextActive=activePathId===pathId?(next[Math.min(index,next.length-1)]?.id??null):activePathId;commitPathChange('Delete path',next,nextActive);announce('Path deleted')};
 const closeDocumentNow=(doc:DocumentModel)=>{if(documentsRef.current.length===1){const fresh=makeDocument('Untitled-1',{w:1200,h:800},zoom,bg);updateDocuments(()=>[fresh]);activateDocument(fresh);return}const remaining=documentsRef.current.filter(item=>item.id!==doc.id);updateDocuments(()=>remaining);if(doc.id===activeDocumentId)activateDocument(remaining.at(-1)!)}; const closeDocument=(doc:DocumentModel)=>{const latest=documentsRef.current.find(item=>item.id===doc.id)??doc;if(latest.dirty){setPendingCloseDocumentId(latest.id);return}closeDocumentNow(latest)};
 const supportedImageExts=new Set(['png','jpg','jpeg','webp','bmp','gif']); const supportedImageMimes=new Set(['image/png','image/jpeg','image/webp','image/bmp','image/gif']); const isSupportedImage=(file:File)=>supportedImageExts.has(file.name.split('.').pop()?.toLowerCase()??'')||supportedImageMimes.has(file.type.toLowerCase());
 const addImage=async(blob:Blob,name:string):Promise<boolean>=>{
  try { await inspectImageBlob(blob); }
  catch(error) { console.error('[PixelForge renderer] image preflight failed',{name,error});announce(`Could not import ${name}: ${error instanceof Error?error.message:'invalid image'}`);return false }
  return new Promise(resolve=>{
   const url=URL.createObjectURL(blob),img=new Image();let settled=false;
   const finish=(ok:boolean,message?:string)=>{if(settled)return;settled=true;URL.revokeObjectURL(url);if(message)announce(message);resolve(ok)};
   img.onload=()=>{
    try {
     assertCanvasDimensions(img.naturalWidth,img.naturalHeight);
     const before=captureSnapshot(),layer=makeLayer(size.w,size.h,name.replace(/\.[^.]+$/,''));
     const scale=Math.min(size.w/img.naturalWidth,size.h/img.naturalHeight,1);
     layer.canvas.getContext('2d')!.drawImage(img,(size.w-img.naturalWidth*scale)/2,(size.h-img.naturalHeight*scale)/2,img.naturalWidth*scale,img.naturalHeight*scale);
     const next=[...layers,layer];setLayers(next);setActive(layer.id);setSelectedIds([layer.id]);
     recordHistory('Place image layer',before,{...before,layers:next,activeLayerId:layer.id,selectedLayerIds:[layer.id]});
     finish(true,`Added ${name} as a new layer`)
    } catch(error) {
     console.error('[PixelForge renderer] image insertion failed',{name,error});
     finish(false,`Could not import ${name}: ${error instanceof Error?error.message:'canvas allocation failed'}`)
    }
   };
   img.onerror=()=>{console.error('[PixelForge renderer] image decode failed',{name,type:blob.type,size:blob.size});finish(false,`Unsupported or invalid image: ${name}`)};
   img.src=url
  })
 };
 const blobFromBase64=(data:string,mimeType:string)=>{const raw=atob(data),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);return new Blob([bytes],{type:mimeType})};
 const upload=()=>{
  if(!window.pixelForge){document.getElementById('file-input')?.click();return}
  void window.pixelForge.openImage().then(file=>{
   if(!file)return;
   const name=file.path.split(/[\\/]/).pop()||'image.png',extension=name.split('.').pop()?.toLowerCase()??'',mimeType=extension==='jpg'||extension==='jpeg'?'image/jpeg':`image/${extension}`;
   void addImage(blobFromBase64(file.data,mimeType),name)
  }).catch(error=>{console.error('[PixelForge renderer] open image failed',error);announce('Could not open image: '+(error instanceof Error?error.message:'invalid image file'))})
 };
 const download=async()=>{
  try {
   const output=mkCanvas(size.w,size.h),context=output.getContext('2d')!;
   context.filter=`brightness(${adjust.brightness}%) contrast(${adjust.contrast}%) saturate(${adjust.saturate}%) blur(${adjust.blur}px)`;
   context.drawImage(viewRef.current!,0,0);
   const data=output.toDataURL('image/png');
   if(window.pixelForge){const path=await window.pixelForge.saveImage({suggestedName:`${title.replace(/\s+/g,'-')}.png`,data});if(path)announce('PNG saved');return}
   const anchor=document.createElement('a');anchor.download=`${title.replace(/\s+/g,'-')}.png`;anchor.href=data;anchor.click();announce('PNG exported')
  } catch(error) { console.error('[PixelForge export] PNG export failed',error);announce('Could not export PNG: '+(error instanceof Error?error.message:'canvas export failed')) }
 };
 const handleDragEnter=(e:React.DragEvent)=>{e.preventDefault();if(Array.from(e.dataTransfer.types).includes('Files')){dragDepth.current++;setIsDragActive(true)}}; const handleDragOver=(e:React.DragEvent)=>{e.preventDefault();if(Array.from(e.dataTransfer.types).includes('Files'))e.dataTransfer.dropEffect='copy'}; const handleDragLeave=(e:React.DragEvent)=>{e.preventDefault();dragDepth.current=Math.max(0,dragDepth.current-1);if(!dragDepth.current)setIsDragActive(false)}; const handleDrop=(e:React.DragEvent)=>{e.preventDefault();e.stopPropagation();dragDepth.current=0;setIsDragActive(false);const files=Array.from(e.dataTransfer.files);if(!files.length){announce('No files received. Drop an image or .pforge project.');return}const projects=files.filter(file=>file.name.toLowerCase().endsWith('.pforge')),accepted=files.filter(file=>!projects.includes(file)&&isSupportedImage(file)),rejected=files.length-projects.length-accepted.length;if(rejected)announce(`${rejected} unsupported file${rejected===1?'':'s'} skipped`);projects.forEach(file=>void importDroppedProject(file));accepted.forEach(file=>{const importFile=async()=>{if(window.pixelForge){const dropped=await window.pixelForge.readDroppedImage(file);if(dropped){await addImage(blobFromBase64(dropped.data,dropped.mimeType),dropped.name);return}}await addImage(file,file.name)};void importFile().catch(error=>{console.error('[PixelForge renderer] dropped image import failed',error);announce(`Could not import ${file.name}: ${error instanceof Error?error.message:'file access failed'}`)})});if(!projects.length&&!accepted.length&&!rejected)announce('Drop a PNG, JPEG, WebP, BMP, GIF or .pforge project')};
 const newDoc=()=>{setNewDocWidth(String(size.w));setNewDocHeight(String(size.h));setNewDocOpen(true)};
 const createNewDoc=()=>{
  const w=Number(newDocWidth),h=Number(newDocHeight);
  try { assertCanvasDimensions(w,h); }
  catch(error) { announce(error instanceof Error?error.message:`Enter dimensions from 1 to ${MAX_DOCUMENT_DIMENSION.toLocaleString()} pixels`);return }
  try {
   const doc=makeDocument('Untitled-'+(documentsRef.current.length+1),{w,h},zoom,bg);
   updateDocuments(docs=>[...docs,{...doc,history:{...doc.history,limit:historyLimit}}]);activateDocument(doc);setNewDocOpen(false);announce('New '+w+' x '+h+' document')
  } catch(error) { console.error('[PixelForge document] creation failed',error);announce('Could not create document: '+(error instanceof Error?error.message:'canvas allocation failed')) }
 };
 const saveDocument=async(documentId=activeDocumentId,saveAs=false):Promise<boolean>=>{const doc=documentsRef.current.find(item=>item.id===documentId);if(!doc)return false;if(!window.pixelForge)return announce('Native project saving is available in the desktop app'),false;try{const savedHistoryId=historyStateId(doc.history),payload=await serializeNativeProject(doc),result=await window.pixelForge.saveProject({suggestedName:(doc.name||'Untitled')+'.pforge',existingPath:doc.projectPath,saveAs,manifest:payload.manifest,assets:payload.assets});if(!result)return false;updateDocuments(docs=>docs.map(item=>item.id===documentId?markDocumentSaved(item,savedHistoryId,result.path):item));announce('Project saved');return true}catch(error){console.error('[PixelForge project] save failed',error);announce('Could not save project: '+(error instanceof Error?error.message:'unknown error'));return false}};
 const acceptProjectPackage=async(project:NativeProjectPackage)=>{try{const doc=await deserializeNativeProject(project);updateDocuments(docs=>[...docs,{...doc,history:{...doc.history,limit:historyLimit}}]);activateDocument(doc);setActivePanel('Layers');announce('Project opened: '+doc.name);return true}catch(error){console.error('[PixelForge project] open failed',error);announce('Could not open project: '+(error instanceof Error?error.message:'invalid file'));return false}};
 const openProject=async()=>{if(!window.pixelForge){projectInputRef.current?.click();return}try{const project=await window.pixelForge.openProject();if(project)await acceptProjectPackage(project)}catch(error){console.error('[PixelForge project] native open failed',error);announce('Could not open project: '+(error instanceof Error?error.message:'invalid file'))}};
 const importDroppedProject=async(file:File)=>{try{if(file.size>MAX_PROJECT_FILE_BYTES)throw new Error('Project files must be 256 MB or smaller.');const project=window.pixelForge?await window.pixelForge.readDroppedProject(file):await parseNativeProjectBytes(await file.arrayBuffer());if(project)await acceptProjectPackage(project);else announce('Could not read the dropped project file')}catch(error){console.error('[PixelForge project] dropped project failed',error);announce('Could not open dropped project: '+(error instanceof Error?error.message:'invalid file'))}};
 const handleProjectFile=async(file?:File)=>{if(!file)return;try{if(file.size>MAX_PROJECT_FILE_BYTES)throw new Error('Project files must be 256 MB or smaller.');await acceptProjectPackage(await parseNativeProjectBytes(await file.arrayBuffer()))}catch(error){console.error('[PixelForge project] file validation failed',error);announce('Could not open project: '+(error instanceof Error?error.message:'invalid file'))}finally{if(projectInputRef.current)projectInputRef.current.value=''}};
 const saveAllBeforeAppClose=async()=>{const dirty=documentsRef.current.filter(doc=>doc.dirty);for(const doc of dirty)if(!await saveDocument(doc.id))return; if(documentsRef.current.some(doc=>doc.dirty))return;setAppClosePrompt(false);try{await window.pixelForge?.allowClose()}catch(error){console.error('[PixelForge close] authorization failed',error);announce('Could not close PixelForge Studio')}};
 const discardAllAndClose=async()=>{setAppClosePrompt(false);try{await window.pixelForge?.allowClose()}catch(error){console.error('[PixelForge close] authorization failed',error);announce('Could not close PixelForge Studio')}};
 const cancelAppClose=async()=>{setAppClosePrompt(false);try{await window.pixelForge?.cancelClose()}catch(error){console.error('[PixelForge close] cancellation failed',error)}};
  const saveAndCloseDocument=async()=>{const id=pendingCloseDocumentId,doc=documentsRef.current.find(item=>item.id===id);if(!doc)return setPendingCloseDocumentId(null);if(await saveDocument(doc.id)){const updated=documentsRef.current.find(item=>item.id===doc.id);if(updated&&!updated.dirty){setPendingCloseDocumentId(null);closeDocumentNow(updated)}}};
 const discardCloseDocument=()=>{const id=pendingCloseDocumentId,doc=documentsRef.current.find(item=>item.id===id);setPendingCloseDocumentId(null);if(doc)closeDocumentNow(doc)};
 const cancelCloseDocument=()=>setPendingCloseDocumentId(null);

 const setLayerProp=(id:number,prop:string,val:unknown)=>{const before=captureSnapshot(),next=layers.map(layer=>layer.id===id?{...layer,[prop]:val}:layer);if(next.every((layer,index)=>layer===layers[index]))return;setLayers(next);if(!propertyGesture.current)recordHistory(`${prop==='visible'?(val?'Show':'Hide'):prop==='opacity'?'Change opacity':prop==='blend'?'Change blending mode':prop==='locked'?(val?'Lock':'Unlock'):'Change layer'}`,before,{...before,layers:next})};
 const beginPropertyGesture=()=>{if(propertyGesture.current)return;propertyBefore.current=captureSnapshot();propertyGesture.current=true};
 const finishPropertyGesture=()=>{if(!propertyGesture.current)return;propertyGesture.current=false;const before=propertyBefore.current;propertyBefore.current=null;if(!before)return;const after=captureSnapshot(),layerAppearanceChanged=before.layers.some((layer,index)=>layer.opacity!==after.layers[index]?.opacity||layer.blend!==after.layers[index]?.blend),effectsChanged=before.layers.some((layer,index)=>JSON.stringify(layer.effects)!==JSON.stringify(after.layers[index]?.effects)),adjustmentsChanged=(Object.keys(DEFAULT_ADJUSTMENTS) as Array<keyof typeof DEFAULT_ADJUSTMENTS>).some(key=>before.adjustments[key]!==after.adjustments[key]),backgroundChanged=before.background!==after.background;const labels=[layerAppearanceChanged?'Change layer appearance':'',effectsChanged?'Edit effects':'',adjustmentsChanged?'Change adjustments':'',backgroundChanged?'Change background':''].filter(Boolean);if(labels.length)recordHistory(labels.join(', '),before,after)};
 const resetAdjustments=()=>{const before=captureSnapshot(),adjustments={...DEFAULT_ADJUSTMENTS};if(Object.keys(adjustments).every(key=>before.adjustments[key as keyof typeof adjustments]===adjustments[key as keyof typeof adjustments]))return;setAdjust(adjustments);if(!propertyGesture.current)recordHistory('Reset adjustments',before,{...before,adjustments})};
 const changeBackground=(background:string)=>{if(background===bg)return;const before=captureSnapshot();setBg(background);recordHistory('Change background',before,{...before,background})};
 const commitDocumentRename=()=>{setRenaming(false);const doc=currentDocument,name=title.trim();if(!doc)return;if(!name){setTitle(doc.name);return}if(name===doc.name){setTitle(name);return}const before=captureSnapshot({name:doc.name}),after={...before,name};setTitle(name);updateDocuments(docs=>docs.map(item=>item.id===doc.id?{...item,name}:item));recordHistory('Rename document',before,after)};
 const isEffectKind=(kind:string):kind is EffectKind=>['brightnessContrast','exposure','hueSaturation','levels','colorBalance','grayscale','invert','sepia','blur','sharpen'].includes(kind);
 const makePresetEffects=(kind:string):LayerEffect[]=>{
  if(kind==='none')return[];
  if(kind==='vintage'){const sepia=createEffect('sepia');sepia.params.amount=55;const contrast=createEffect('brightnessContrast');contrast.params.contrast=12;const saturation=createEffect('hueSaturation');saturation.params.saturation=-22;return[sepia,contrast,saturation]}
  if(kind==='sharpen'){const effect=createEffect('sharpen');effect.params.amount=60;return[effect]}
  return isEffectKind(kind)?[createEffect(kind)]:[]
 };
 const createAdjustmentLayer=(kind:EffectKind=newEffectKind)=>{
  const before=captureSnapshot(),effect=createEffect(kind),parentId=current?.type==='group'?current.id:current?.parentId;
  const layer=makeLayer(1,1,`${effectName(kind)} Adjustment`,'adjustment',parentId);layer.width=size.w;layer.height=size.h;layer.effects=[effect];
  const siblings=layers.filter(item=>item.parentId===parentId),lastSibling=siblings.at(-1);let insertionIndex=layers.length;
  if(lastSibling){insertionIndex=layers.findIndex(item=>item.id===lastSibling.id);for(let index=insertionIndex+1;index<layers.length;index++)if(isDescendantOf(layers[index],lastSibling.id,layers))insertionIndex=index;insertionIndex++}
  else if(parentId!==undefined){const parentIndex=layers.findIndex(item=>item.id===parentId);insertionIndex=parentIndex+1}
  const next=[...layers];next.splice(insertionIndex,0,layer);setLayers(next);setActive(layer.id);setSelectedIds([layer.id]);setActivePanel('Adjustments');
  recordHistory(`Add ${effectName(kind)} adjustment`,before,{...before,layers:next,activeLayerId:layer.id,selectedLayerIds:[layer.id]});announce(`${effectName(kind)} adjustment layer added`)
 };
 const updateLayerEffects=(layerId:number,effects:LayerEffect[],label:string)=>{
  const before=captureSnapshot(),next=layers.map(layer=>layer.id===layerId?{...layer,effects}:layer);
  if(next.every((layer,index)=>layer===layers[index]))return;
  setLayers(next);recordHistory(label,before,{...before,layers:next})
 };
 const addEffectToCurrent=()=>{
  if(!current)return createAdjustmentLayer(newEffectKind);
  if(current.type==='group')return createAdjustmentLayer(newEffectKind);
  updateLayerEffects(current.id,[...current.effects,createEffect(newEffectKind)],`Add ${effectName(newEffectKind)} effect`)
 };
 const editEffect=(layerId:number,effectId:string,key:string,value:number|boolean)=>{
  setLayers(items=>items.map(layer=>layer.id===layerId?{...layer,effects:layer.effects.map(effect=>{
   if(effect.id!==effectId)return effect;
   const nextValue=effect.kind==='levels'&&key==='inputBlack'?Math.min(Number(value),Number(effect.params.inputWhite)-1)
    :effect.kind==='levels'&&key==='inputWhite'?Math.max(Number(value),Number(effect.params.inputBlack)+1):value;
   return{...effect,params:{...effect.params,[key]:nextValue}}
  })}:layer))
 };
 const setEffectEnabled=(layer:Layer,effectId:string,enabled:boolean)=>updateLayerEffects(layer.id,layer.effects.map(effect=>effect.id===effectId?{...effect,enabled}:effect),enabled?'Enable effect':'Disable effect');
 const moveEffect=(layer:Layer,index:number,direction:-1|1)=>{
  const target=index+direction;if(target<0||target>=layer.effects.length)return;
  const effects=[...layer.effects],[effect]=effects.splice(index,1);effects.splice(target,0,effect);
  updateLayerEffects(layer.id,effects,'Reorder effects')
 };
 const resetEffect=(layer:Layer,effect:LayerEffect)=>{
  const defaults=createEffect(effect.kind,effect.id);defaults.enabled=effect.enabled;
  updateLayerEffects(layer.id,layer.effects.map(item=>item.id===effect.id?defaults:item),`Reset ${effectName(effect.kind)}`)
 };
 const removeEffect=(layer:Layer,effectId:string)=>updateLayerEffects(layer.id,layer.effects.filter(effect=>effect.id!==effectId),'Remove effect');
 const applyFilter=(kind:string)=>{
  if(!current)return;
  const effects=makePresetEffects(kind);
  if(selection?.bounds&&current.type==='pixel'&&kind!=='none'){
   const bounds=selection.bounds,canvas=current.canvas,context=canvas.getContext('2d')!,before=captureSnapshot(),pixels=context.getImageData(bounds.x,bounds.y,bounds.width,bounds.height),filtered=applyEffectStack(pixels.data,bounds.width,bounds.height,effects);
   beginPixelTransaction(current.id,'canvas',canvas);drawingBefore.current=before;capturePixelTiles(canvas,{left:bounds.x,top:bounds.y,right:bounds.x+bounds.width,bottom:bounds.y+bounds.height});
   const output=context.createImageData(bounds.width,bounds.height);output.data.set(filtered);context.putImageData(output,bounds.x,bounds.y);applySelectionPixels(canvas,pixels,bounds);
   setLayers(items=>items.map(layer=>layer.id===current.id?{...layer}:layer));finishPixelTransaction();announce(`${kind} applied to selection`);return
  }
  const before=captureSnapshot(),next=layers.map(layer=>layer.id===current.id?{...layer,filter:kind==='none'?'none':layer.filter,effects:kind==='none'?[]:[...layer.effects,...effects]}:layer);
  setLayers(next);recordHistory(kind==='none'?'Reset layer effects':`Add ${kind} effect`,before,{...before,layers:next});announce(kind==='none'?'Layer effects reset':`${kind} effect added`)
 };
 const flip=(horizontal=true)=>{if(!current||current.type==='group'||current.type==='adjustment')return;try{const before=captureSnapshot(),flipBuffer=(source:HTMLCanvasElement)=>{const canvas=mkCanvas(source.width,source.height),ctx=canvas.getContext('2d')!;if(horizontal){ctx.translate(source.width,0);ctx.scale(-1,1)}else{ctx.translate(0,source.height);ctx.scale(1,-1)}ctx.drawImage(source,0,0);return canvas},next=layers.map(layer=>layer.id===current.id?(layer.type==='pixel'?{...layer,canvas:flipBuffer(layer.canvas),mask:layer.mask?flipBuffer(layer.mask):undefined}:layer.type==='text'||layer.type==='shape'?{...layer,flipX:horizontal?!layer.flipX:layer.flipX,flipY:horizontal?layer.flipY:!layer.flipY}:layer):layer);setLayers(next);recordHistory(horizontal?'Flip layer horizontally':'Flip layer vertically',before,{...before,layers:next});announce(horizontal?'Layer flipped horizontally':'Layer flipped vertically')}catch(error){reportOperationFailure('flip layer',error)}}
 const modifyCurrentSelection=(amount:number,expand:boolean)=>{if(!selection)return;const before=captureSnapshot(),next=modifySelection(selection,amount,expand);setPreviousSelection(selection);setSelection(next);recordHistory(expand?'Expand selection':'Contract selection',before,{...before,selection:next,previousSelection:selection})};
 const featherCurrentSelection=()=>{if(!selection)return;const before=captureSnapshot(),next=featherSelection(selection,selectionFeather);setPreviousSelection(selection);setSelection(next);recordHistory('Feather selection',before,{...before,selection:next,previousSelection:selection})};
 const clearSelectedPixels=()=>{if(!selection||!current||current.type!=='pixel'||current.locked)return;const b=selection.bounds;if(!b)return;const before=captureSnapshot(),canvas=current.canvas,ctx=canvas.getContext('2d')!,x=b.x,y=b.y,w=b.width,h=b.height,image=ctx.getImageData(x,y,w,h);beginPixelTransaction(current.id,'canvas',canvas);drawingBefore.current=before;capturePixelTiles(canvas,{left:x,top:y,right:x+w,bottom:y+h});for(let py=0;py<h;py++)for(let px=0;px<w;px++){const i=(py*w+px)*4,a=maskAlphaAt(selection.mask,x+px,y+py)/255;image.data[i+3]=Math.round(image.data[i+3]*(1-a))}ctx.putImageData(image,x,y);setLayers(ls=>ls.map(l=>l.id===current.id?{...l}:l));finishPixelTransaction()};
 const selectionClipboard=useRef<{canvas:HTMLCanvasElement;x:number;y:number}|null>(null);
 const copySelection=()=>{if(!selection||!current||current.type!=='pixel'||!selection.bounds)return;try{const b=selection.bounds,c=mkCanvas(b.width,b.height),ctx=c.getContext('2d')!,pixels=current.canvas.getContext('2d')!.getImageData(b.x,b.y,b.width,b.height);for(let y=0;y<b.height;y++)for(let x=0;x<b.width;x++)pixels.data[(y*b.width+x)*4+3]=Math.round(pixels.data[(y*b.width+x)*4+3]*maskAlphaAt(selection.mask,b.x+x,b.y+y)/255);ctx.putImageData(pixels,0,0);selectionClipboard.current={canvas:c,x:b.x,y:b.y};announce('Selection copied')}catch(error){reportOperationFailure('copy selection',error)}};
 const cutSelection=()=>{copySelection();clearSelectedPixels()};
 const pasteSelection=()=>{const clip=selectionClipboard.current;if(!clip)return;try{const before=captureSnapshot(),layer=makeLayer(size.w,size.h,'Pasted selection');layer.canvas.getContext('2d')!.drawImage(clip.canvas,clip.x,clip.y);const next=[...layers,layer];setLayers(next);setActive(layer.id);setSelectedIds([layer.id]);recordHistory('Paste selection',before,{...before,layers:next,activeLayerId:layer.id,selectedLayerIds:[layer.id]});announce('Selection pasted as a new layer')}catch(error){reportOperationFailure('paste selection',error)}};
 const fillSelection=()=>{if(!selection||!current||current.type!=='pixel'||current.locked||!selection.bounds)return;const b=selection.bounds,canvas=current.canvas,ctx=canvas.getContext('2d')!,before=captureSnapshot(),image=ctx.getImageData(b.x,b.y,b.width,b.height),rgba=[parseInt(color.slice(1,3),16),parseInt(color.slice(3,5),16),parseInt(color.slice(5,7),16)];beginPixelTransaction(current.id,'canvas',canvas);drawingBefore.current=before;capturePixelTiles(canvas,{left:b.x,top:b.y,right:b.x+b.width,bottom:b.y+b.height});for(let y=0;y<b.height;y++)for(let x=0;x<b.width;x++){const i=(y*b.width+x)*4,a=maskAlphaAt(selection.mask,b.x+x,b.y+y)/255*opacity/100;if(!a)continue;const da=image.data[i+3]/255,oa=a+da*(1-a);for(let c=0;c<3;c++)image.data[i+c]=oa?Math.round((rgba[c]*a+image.data[i+c]*da*(1-a))/oa):0;image.data[i+3]=Math.round(oa*255)}ctx.putImageData(image,b.x,b.y);setLayers(ls=>ls.map(l=>l.id===current.id?{...l}:l));finishPixelTransaction()};
 const createLayerMask=(fromSelection=false)=>{
  const layer=current;
  if(!layer||layer.type==='group'){announce('Select a pixel, text, or shape layer first');return}
  if(layer.mask){announce(fromSelection?'Remove the current mask before creating another':'This layer already has a mask');return}
  if(fromSelection&&!selection){announce('Create a selection before adding a mask from it');return}
  try{
  const width=Math.max(1,Math.round(layer.type==='pixel'?layer.canvas.width:layer.width)),height=Math.max(1,Math.round(layer.type==='pixel'?layer.canvas.height:layer.height)),mask=mkCanvas(width,height),ctx=mask.getContext('2d')!;
  if(fromSelection&&selection){
   const bounds=selection.bounds;
   const corners=bounds?[
    {x:bounds.x,y:bounds.y},{x:bounds.x+bounds.width,y:bounds.y},
    {x:bounds.x,y:bounds.y+bounds.height},{x:bounds.x+bounds.width,y:bounds.y+bounds.height},
   ].map(point=>documentToMaskPoint(point,layer)):null;
   const localBounds=corners?{
    x:Math.max(0,Math.floor(Math.min(...corners.map(point=>point.x)))),
    y:Math.max(0,Math.floor(Math.min(...corners.map(point=>point.y)))),
    width:Math.max(0,Math.min(width,Math.ceil(Math.max(...corners.map(point=>point.x))))-Math.max(0,Math.floor(Math.min(...corners.map(point=>point.x))))),
    height:Math.max(0,Math.min(height,Math.ceil(Math.max(...corners.map(point=>point.y))))-Math.max(0,Math.floor(Math.min(...corners.map(point=>point.y))))),
   }:null;
   const pixels=selectionMaskPixels(width,height,localBounds,(x,y)=>{const point=maskToDocumentPoint({x:x+.5,y:y+.5},layer);return maskAlphaAt(selection.mask,Math.floor(point.x),Math.floor(point.y))});
   const image=ctx.createImageData(width,height);image.data.set(pixels);ctx.putImageData(image,0,0)
  }else{
   ctx.fillStyle='#ffffff';ctx.fillRect(0,0,width,height)
  }
  const before=captureSnapshot(),next=layers.map(item=>item.id===layer.id?{...item,mask,maskEnabled:true,maskMode:'alpha' as const}:item);
  setLayers(next);recordHistory(fromSelection?'Add mask from selection':'Add layer mask',before,{...before,layers:next});setTool('mask');announce(fromSelection?'Layer mask created from selection':'Layer mask added')
  }catch(error){reportOperationFailure('create layer mask',error)}
 };
 const createMaskFromSelection=()=>createLayerMask(true);
 const removeLayerMask=()=>{
  if(!current?.mask)return;
  const before=captureSnapshot(),next=layers.map(layer=>layer.id===current.id?{...layer,mask:undefined,maskEnabled:false}:layer);
  setLayers(next);recordHistory('Remove layer mask',before,{...before,layers:next});if(tool==='mask')setTool('brush');announce('Layer mask removed')
 };
 const invertLayerMask=()=>{
  const layer=current;if(!layer?.mask)return;
  const before=captureSnapshot(),mask=layer.mask;drawingBefore.current=before;beginPixelTransaction(layer.id,'mask',mask);
  const tileSize=128;
  capturePixelTiles(mask,{left:0,top:0,right:mask.width,bottom:mask.height});
  const context=brushReadContext(mask);
  for(let y=0;y<mask.height;y+=tileSize)for(let x=0;x<mask.width;x+=tileSize){
   const image=context.getImageData(x,y,Math.min(tileSize,mask.width-x),Math.min(tileSize,mask.height-y));
   image.data.set(invertMaskPixels(image.data));context.putImageData(image,x,y)
  }
  finishPixelTransaction(false,false,'Invert layer mask')
 };
 const tools: [Tool,string,any][]=[['crop','Crop',Crop],['move','Move / transform',MousePointer2],['marquee','Rectangular marquee',Crop],['ellipseSelect','Elliptical marquee',Circle],['rowSelect','Single row',ScanLine],['columnSelect','Single column',Columns3],['lasso','Freehand lasso',Lasso],['polygonLasso','Polygonal lasso',LassoSelect],['wand','Magic wand',WandSparkles],['brush','Brush',Brush],['eraser','Eraser',Eraser],['mask','Mask brush',Aperture],['clone','Clone stamp',Copy],['healing','Healing brush',Paintbrush],['gradient','Gradient',Blend],['fill','Flood fill',PaintBucket],['rectangle','Rectangle',Square],['roundedRectangle','Rounded rectangle',Square],['ellipse','Ellipse',Circle],['line','Line',MinusIcon],['polygon','Polygon',Shapes],['star','Star',Sparkles],['text','Text',Type],['hand','Hand',Hand]];
 const shortcuts=useCallback((e:KeyboardEvent)=>{const target=e.target as HTMLElement;if(target.closest('input,textarea,select,[contenteditable="true"]'))return;const mod=e.ctrlKey||e.metaKey;if(mod&&e.key.toLowerCase()==='o'){e.preventDefault();void openProject();return}if(mod&&e.shiftKey&&e.key.toLowerCase()==='s'){e.preventDefault();void saveDocument(activeDocumentId,true);return}if(mod&&e.key.toLowerCase()==='s'){e.preventDefault();void saveDocument();return}if(mod&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo();return}if(mod&&e.key.toLowerCase()==='y'){e.preventDefault();redo();return}if(mod&&e.key.toLowerCase()==='a'){e.preventDefault();selectEverything();return}if(mod&&e.key.toLowerCase()==='d'){e.preventDefault();clearSelection();return}if(mod&&e.key.toLowerCase()==='c'){e.preventDefault();copySelection();return}if(mod&&e.key.toLowerCase()==='x'){e.preventDefault();cutSelection();return}if(mod&&e.key.toLowerCase()==='v'){e.preventDefault();pasteSelection();return}if(mod&&e.shiftKey&&e.key.toLowerCase()==='i'){e.preventDefault();invertCurrentSelection();return}if(mod&&e.shiftKey&&e.key.toLowerCase()==='n'){e.preventDefault();addLayer();return}if(mod&&e.key.toLowerCase()==='j'){e.preventDefault();duplicateActiveLayer();return}if(e.key==='Escape'){if(tool==='crop'&&cropRect){cancelCrop();return}if(resizeOpen){setResizeOpen(false);return}setPolygonPoints([]);setSelectionPreview(null);drawing.current=false;return}if(e.key==='Enter'&&tool==='polygonLasso'&&polygonPoints.length>=3){const incoming=rasterizeSelection(size.w,size.h,'polygon',polygonPoints[0],polygonPoints.at(-1)!,polygonPoints,selectionAA);commitSelection(incoming,'Polygonal lasso');setPolygonPoints([]);return}if(e.key==='Backspace'&&tool==='polygonLasso'){setPolygonPoints(points=>points.slice(0,-1));return}if(e.key==='Delete'){e.preventDefault();if(selection&&current&&current.type==='pixel')clearSelectedPixels();else deleteActiveLayer();return}if(e.key.toLowerCase()==='m')setTool('marquee');if(e.key.toLowerCase()==='l')setTool('lasso');if(e.key.toLowerCase()==='w')setTool('wand');if(e.key.toLowerCase()==='b')setTool('brush');if(e.key.toLowerCase()==='e')setTool('eraser');if(e.key.toLowerCase()==='t')setTool('text');if(e.key==='[')setBrushSize(x=>Math.max(1,x-4));if(e.key===']')setBrushSize(x=>x+4)},[layers,active,selectedIds,documents,selection,polygonPoints,tool]);useEffect(()=>{window.addEventListener('keydown',shortcuts);return()=>window.removeEventListener('keydown',shortcuts)},[shortcuts]);
 useEffect(()=>{if(tool==='clone'||tool==='healing')setActivePanel('Retouch')},[tool]);
 useEffect(()=>{
  const retouchShortcuts=(event:KeyboardEvent)=>{
   const target=event.target as HTMLElement;if(target.closest('input,textarea,select,[contenteditable="true"]')||event.ctrlKey||event.metaKey||event.altKey)return;
   if(event.key.toLowerCase()==='s')setTool('clone');
   if(event.key.toLowerCase()==='j')setTool('healing')
  };
  window.addEventListener('keydown',retouchShortcuts);return()=>window.removeEventListener('keydown',retouchShortcuts)
 },[]);
 useEffect(()=>{
  if(retouchStroke.current)cancelRetouchStroke();
  setRetouchSourcePoint(null);setRetouchSourceIndicator(null);retouchTargetAnchor.current=null
 },[activeDocumentId]);
 const layerCount=layers.length; const activeName=current?.name??'Layer';
 useEffect(()=>{if(!window.pixelForge)return;return window.pixelForge.onCloseRequested(()=>{if(documentsRef.current.some(doc=>doc.dirty))setAppClosePrompt(true);else void window.pixelForge?.allowClose().catch(error=>{console.error('[PixelForge close] failed',error);announce('Could not close PixelForge Studio')})})},[]);
 const [prefsReady,setPrefsReady]=useState(false);useEffect(()=>{const onError=(e:ErrorEvent)=>console.error('[PixelForge renderer] uncaught error',e.error||e.message);const onRejection=(e:PromiseRejectionEvent)=>console.error('[PixelForge renderer] unhandled rejection',e.reason);window.addEventListener('error',onError);window.addEventListener('unhandledrejection',onRejection);let live=true;window.pixelForge?.readPreferences().then(p=>{if(!live)return;if(typeof p.zoom==='number')setZoom(p.zoom);if(typeof p.bg==='string')setBg(p.bg);if(typeof p.color==='string')setColor(p.color);if(typeof p.title==='string')setTitle(p.title);setPrefsReady(true)}).catch(error=>{console.error('[PixelForge renderer] preferences load failed',error);if(live)setPrefsReady(true)});if(!window.pixelForge)setPrefsReady(true);return()=>{live=false;window.removeEventListener('error',onError);window.removeEventListener('unhandledrejection',onRejection)}},[]);useEffect(()=>{if(prefsReady)void window.pixelForge?.writePreferences({zoom,bg,color,tool,title}).catch(error=>console.error('[PixelForge renderer] preferences save failed',error))},[prefsReady,zoom,bg,color,tool,title]);
 const [brushPrefsReady,setBrushPrefsReady]=useState(false);useEffect(()=>{try{const raw=localStorage.getItem('pixelforge.brush.v1');if(raw){const saved=JSON.parse(raw) as {presets?:BrushPreset[];settings?:BrushEngineSettings;activePreset?:string};if(Array.isArray(saved.presets)&&saved.presets.every(item=>item&&typeof item.name==='string'&&item.settings))setBrushPresets(saved.presets);if(saved.settings)applyBrushSettings({...DEFAULT_BRUSH_SETTINGS,...saved.settings},saved.activePreset)} }catch(error){console.error('[PixelForge brush] settings load failed',error)}finally{setBrushPrefsReady(true)}},[]);useEffect(()=>{if(!brushPrefsReady)return;try{localStorage.setItem('pixelforge.brush.v1',JSON.stringify({presets:brushPresets,settings:currentBrushSettings(),activePreset:activeBrushPreset}))}catch(error){console.error('[PixelForge brush] settings save failed',error)}},[brushPrefsReady,brushPresets,brushSize,hardness,opacity,flow,spacing,smoothing,brushBlend,brushTip,pressureSize,pressureOpacity,pressureFlow,activeBrushPreset]);
 const [activePanel,setActivePanel]=useState('Layers'); const [openMenu,setOpenMenu]=useState<string|null>(null);
 const menuActions:Record<string,[string,()=>void][]>={File:[['Open project...',openProject],['New document',newDoc],['Save',()=>void saveDocument()],['Save As...',()=>void saveDocument(activeDocumentId,true)],['Import image layer',upload],['Export PNG',download]],Edit:[['Undo',undo],['Redo',redo],['Copy selection',copySelection],['Cut selection',cutSelection],['Paste selection',pasteSelection],['Fill selection',fillSelection],['Reset adjustments',resetAdjustments]],Image:[['New document',newDoc],['Crop to boundary',applyCrop],['Resize image...',resizeImage],['Rotate canvas 90 deg clockwise',()=>rotateCanvas(90)],['Rotate canvas 90 deg counterclockwise',()=>rotateCanvas(270)],['Rotate canvas 180 deg',()=>rotateCanvas(180)],['Flip canvas horizontal',()=>rotateCanvas(0)],['Flip canvas vertical',()=>rotateCanvas(-1)],['Flip active layer horizontal',()=>flip(true)],['Flip active layer vertical',()=>flip(false)]],Layer:[['New layer',addLayer],['Edit text',()=>current?.type==='text'&&openTextEditor(current)],['Flip layer horizontal',flip],['Duplicate layer',duplicateActiveLayer],['Group layers',groupSelectedLayers],['Ungroup layer',ungroupActiveLayer],['Move layer up',()=>changeLayerOrder(active,1)],['Move layer down',()=>changeLayerOrder(active,-1)],['Delete layer',deleteActiveLayer]],Select:[['Select all',selectEverything],['Deselect',clearSelection],['Reselect',()=>previousSelection&&commitSelection(previousSelection,'Reselect','replace',false)],['Invert selection',invertCurrentSelection],['Feather selection',featherCurrentSelection],['Expand selection',()=>modifyCurrentSelection(1,true)],['Contract selection',()=>modifyCurrentSelection(1,false)],['Clear selected pixels',clearSelectedPixels],['Add mask from selection',createMaskFromSelection]],Filter:[['Black & white',()=>applyFilter('grayscale')],['Vintage',()=>applyFilter('vintage')],['Invert',()=>applyFilter('invert')]],View:[['Zoom in',()=>setZoom(z=>Math.min(150,z+10))],['Zoom out',()=>setZoom(z=>Math.max(10,z-10))],['Fit canvas',()=>setZoom(Math.min(100,Math.round(Math.min((window.innerWidth-420)/size.w,(window.innerHeight-240)/size.h)*100)))]],Window:[['Layers panel',()=>setActivePanel('Layers')],['Brush settings',()=>setActivePanel('Brush')],['Adjustments panel',()=>setActivePanel('Adjustments')],['History panel',()=>setActivePanel('History')]],Help:[['About PixelForge Studio',()=>announce('PixelForge Studio | Desktop image editor')]]};
 const currentBrushSettings=():BrushEngineSettings=>({size:brushSize,hardness,opacity,flow,spacing,smoothing,blend:brushBlend,tip:brushTip,pressureSize,pressureOpacity,pressureFlow}); const applyBrushSettings=(settings:BrushEngineSettings,presetId?:string)=>{setBrushSize(settings.size);setHardness(settings.hardness);setOpacity(settings.opacity);setFlow(settings.flow);setSpacing(settings.spacing);setSmoothing(settings.smoothing);setBrushBlend(settings.blend);setBrushTip(settings.tip);setPressureSize(settings.pressureSize);setPressureOpacity(settings.pressureOpacity);setPressureFlow(settings.pressureFlow);if(presetId)setActiveBrushPreset(presetId)}; const saveBrushPreset=()=>{const name=presetName.trim();if(!name)return announce('Enter a preset name');const item:BrushPreset={id:`custom-${Date.now()}`,name,settings:currentBrushSettings(),custom:true};const next=[...brushPresets,item];setBrushPresets(next);setActiveBrushPreset(item.id);setPresetName('');announce('Brush preset saved')}; const updateSelectedBrushPreset=()=>{const existing=brushPresets.find(item=>item.id===activeBrushPreset);if(!existing)return;const next=brushPresets.map(item=>item.id===existing.id?{...item,settings:currentBrushSettings()}:item);setBrushPresets(next);announce('Brush preset updated')}; const renameSelectedBrushPreset=()=>{const name=presetName.trim(),existing=brushPresets.find(item=>item.id===activeBrushPreset&&item.custom);if(!name||!existing)return;setBrushPresets(items=>items.map(item=>item.id===existing.id?{...item,name}:item));setPresetName('');setRenamingPreset(false);announce('Brush preset renamed')}; const deleteSelectedBrushPreset=()=>{const existing=brushPresets.find(item=>item.id===activeBrushPreset&&item.custom);if(!existing)return;setBrushPresets(items=>items.filter(item=>item.id!==existing.id));applyBrushSettings(STARTER_BRUSHES[0].settings,STARTER_BRUSHES[0].id);announce('Brush preset deleted')}; const resetBrushPresets=()=>{setBrushPresets(STARTER_BRUSHES);applyBrushSettings(STARTER_BRUSHES[0].settings,STARTER_BRUSHES[0].id);announce('Default brush presets restored')}; const renderBrushPanel=()=>{const picked=brushPresets.find(item=>item.id===activeBrushPreset),value=currentBrushSettings();const range=(label:string,key:'size'|'hardness'|'opacity'|'flow'|'spacing'|'smoothing',min:number,max:number,unit:string)=> <label className="brush-control"><span>{label}</span><input aria-label={label} type="range" min={min} max={max} value={value[key]} onChange={event=>{const v=+event.target.value;({size:setBrushSize,hardness:setHardness,opacity:setOpacity,flow:setFlow,spacing:setSpacing,smoothing:setSmoothing}[key])(v)}}/><input aria-label={`${label} value`} type="number" min={min} max={max} value={value[key]} onChange={event=>{const v=Math.max(min,Math.min(max,+event.target.value||min));({size:setBrushSize,hardness:setHardness,opacity:setOpacity,flow:setFlow,spacing:setSpacing,smoothing:setSmoothing}[key])(v)}}/><small>{unit}</small></label>;return <><div className="panel-heading"><span>BRUSH PRESETS</span><button className="quiet-button" onClick={resetBrushPresets}>Reset defaults</button></div><div className="brush-presets">{brushPresets.map(item=><button key={item.id} className={activeBrushPreset===item.id?'active':''} onClick={()=>applyBrushSettings(item.settings,item.id)}><span className={`brush-preset-dot ${item.settings.tip}`} style={{width:Math.max(7,Math.min(27,item.settings.size/3))}}/><span>{item.name}</span></button>)}</div><div className="brush-preview-wrap"><canvas className="brush-preview" ref={el=>{if(!el)return;el.width=220;el.height=62;const c=el.getContext('2d')!;c.clearRect(0,0,220,62);const radius=Math.max(1,Math.min(26,value.size/2));c.globalAlpha=value.opacity/100*value.flow/100;c.fillStyle=color;c.beginPath();c.arc(110,31,radius,0,Math.PI*2);if(value.tip==='soft'){const g=c.createRadialGradient(110,31,0,110,31,radius);g.addColorStop(0,color);g.addColorStop(1,`${color}00`);c.fillStyle=g}else if(value.tip!=='pencil'){const g=c.createRadialGradient(110,31,0,110,31,radius);g.addColorStop(0,color);g.addColorStop(Math.min(.99,value.hardness/100),color);g.addColorStop(1,`${color}00`);c.fillStyle=g}c.fill()}}/><span>{picked?.name??'Custom brush'} ? {value.size}px</span></div><div className="brush-settings-list">{range('Size','size',1,500,'px')}{range('Hardness','hardness',0,100,'%')}{range('Opacity','opacity',1,100,'%')}{range('Flow','flow',1,100,'%')}{range('Spacing','spacing',1,200,'%')}{range('Smoothing','smoothing',0,100,'%')}<label className="brush-select-row">Tip<select value={brushTip} onChange={event=>setBrushTip(event.target.value as BrushEngineSettings['tip'])}><option value="round">Round</option><option value="soft">Soft round</option><option value="pencil">Pencil</option><option value="texture">Texture</option></select></label><label className="brush-select-row">Blend mode<select value={brushBlend} onChange={event=>setBrushBlend(event.target.value as GlobalCompositeOperation)}><option value="source-over">Normal</option><option value="multiply">Multiply</option><option value="screen">Screen</option><option value="overlay">Overlay</option><option value="darken">Darken</option><option value="lighten">Lighten</option><option value="soft-light">Soft light</option></select></label><div className="brush-pressure"><b>Stylus pressure</b><label><input type="checkbox" checked={pressureSize} onChange={event=>setPressureSize(event.target.checked)}/>Size</label><label><input type="checkbox" checked={pressureOpacity} onChange={event=>setPressureOpacity(event.target.checked)}/>Opacity</label><label><input type="checkbox" checked={pressureFlow} onChange={event=>setPressureFlow(event.target.checked)}/>Flow</label></div></div><div className="brush-save">{renamingPreset?<input value={presetName} placeholder="Preset name" onChange={event=>setPresetName(event.target.value)} onKeyDown={event=>event.key==='Enter'&&renameSelectedBrushPreset()}/>:<input value={presetName} placeholder="Custom preset name" onChange={event=>setPresetName(event.target.value)} onKeyDown={event=>event.key==='Enter'&&saveBrushPreset()}/>}<button className="wide-action" onClick={renamingPreset?renameSelectedBrushPreset:saveBrushPreset}>{renamingPreset?'Rename':'Save preset'}</button><button className="wide-action" disabled={!picked?.custom} onClick={updateSelectedBrushPreset}>Update</button>{picked?.custom&&<><button className="wide-action" onClick={()=>{setPresetName(picked.name);setRenamingPreset(true)}}>Rename</button><button className="wide-action" onClick={deleteSelectedBrushPreset}>Delete</button></>}</div></>};
 const renderEffect=(layer:Layer,effect:LayerEffect,index:number)=> <div className={`effect-card ${effect.enabled?'':'disabled'}`} key={effect.id}>
  <div className="effect-card-heading">
   <label title={effect.enabled?'Disable effect':'Enable effect'}><input type="checkbox" checked={effect.enabled} onChange={event=>setEffectEnabled(layer,effect.id,event.target.checked)}/><b>{effectName(effect.kind)}</b></label>
   <div><button title="Move effect earlier" disabled={index===0} onClick={()=>moveEffect(layer,index,-1)}><ArrowUp size={12}/></button><button title="Move effect later" disabled={index===layer.effects.length-1} onClick={()=>moveEffect(layer,index,1)}><ArrowDown size={12}/></button><button title="Reset effect parameters" onClick={()=>resetEffect(layer,effect)}><ResetIcon size={12}/></button><button title="Remove effect" onClick={()=>removeEffect(layer,effect.id)}><X size={12}/></button></div>
  </div>
  {effectParameterSpecs(effect.kind).length>0||effect.kind==='colorBalance'?<div className="effect-parameters" onPointerDownCapture={beginPropertyGesture} onPointerUpCapture={finishPropertyGesture} onPointerCancelCapture={finishPropertyGesture} onKeyDownCapture={beginPropertyGesture} onKeyUpCapture={finishPropertyGesture} onBlurCapture={finishPropertyGesture}>
   {effectParameterSpecs(effect.kind).map(spec=><label className="effect-parameter" key={spec.key}><span>{spec.label}</span><input aria-label={`${effectName(effect.kind)} ${spec.label}`} type="range" min={spec.min} max={spec.max} step={spec.step} value={Number(effect.params[spec.key])} onChange={event=>editEffect(layer.id,effect.id,spec.key,+event.target.value)}/><small>{Number(effect.params[spec.key])}{spec.unit?' '+spec.unit:''}</small></label>)}
   {effect.kind==='colorBalance'&&<label className="effect-check"><input type="checkbox" checked={effect.params.preserveLuminosity===true} onChange={event=>editEffect(layer.id,effect.id,'preserveLuminosity',event.target.checked)}/>Preserve luminosity</label>}
  </div>:<small className="effect-note">{effect.enabled?'Preview is active.':'Effect is disabled.'}</small>}
 </div>;
 const renderAdjustments=()=> <div>
  <div className="panel-heading"><span>DOCUMENT PREVIEW</span><button className="quiet-button" onClick={resetAdjustments}>Reset</button></div>
  {([['Brightness','brightness',0,200],['Contrast','contrast',0,200],['Saturation','saturate',0,200],['Blur','blur',0,20]] as const).map(([label,key,min,max])=><label className="adjust-row" key={key}><span>{label}</span><input type="range" min={min} max={max} value={adjust[key]} onPointerDownCapture={beginPropertyGesture} onPointerUpCapture={finishPropertyGesture} onKeyDownCapture={beginPropertyGesture} onKeyUpCapture={finishPropertyGesture} onBlur={finishPropertyGesture} onChange={e=>setAdjust(a=>({...a,[key]:+e.target.value}))}/><small>{adjust[key]}{key==='blur'?'px':'%'}</small></label>)}
  <div className="panel-heading section-gap"><span>ADJUSTMENT LAYER</span></div>
  <div className="effect-add-row"><select aria-label="New adjustment type" value={newEffectKind} onChange={event=>setNewEffectKind(event.target.value as EffectKind)}>{(['brightnessContrast','exposure','hueSaturation','levels','colorBalance','grayscale','invert'] as EffectKind[]).map(kind=><option key={kind} value={kind}>{effectName(kind)}</option>)}</select><button title="Create a non-destructive adjustment layer" onClick={()=>createAdjustmentLayer(newEffectKind)}><Plus size={13}/> Add layer</button></div>
  <div className="panel-heading section-gap"><span>{current?.type==='adjustment'?'ADJUSTMENT STACK':'LAYER EFFECTS'}</span><em>{current?.effects.length??0}</em></div>
  <div className="effect-add-row"><select aria-label="New effect type" value={newEffectKind} onChange={event=>setNewEffectKind(event.target.value as EffectKind)}>{(['brightnessContrast','exposure','hueSaturation','levels','colorBalance','grayscale','invert','sepia','blur','sharpen'] as EffectKind[]).map(kind=><option key={kind} value={kind}>{effectName(kind)}</option>)}</select><button title="Add an editable effect to the selected layer" disabled={!current} onClick={addEffectToCurrent}><Plus size={13}/> Add effect</button></div>
  {!current?<div className="empty-panel">Select a layer to edit its non-destructive effect stack.</div>:current.effects.length?<div className="effect-stack">{current.effects.map((effect,index)=>renderEffect(current,effect,index))}</div>:<div className="empty-panel">{current.type==='adjustment'?'Add an effect to this adjustment layer.':'No layer effects. Add an effect to preview it without changing source pixels.'}</div>}
  <div className="panel-heading section-gap"><span>FILTER PRESETS</span><button className="quiet-button" onClick={()=>current&&applyFilter('none')}>Clear</button></div>
  <div className="filter-grid">{[['Original','none'],['B&W','grayscale'],['Vintage','vintage'],['Sepia','sepia'],['Invert','invert'],['Crisp','sharpen']].map(([label,key])=><button key={key} className={`filter-card ${current?.filter===key?'chosen':''}`} onClick={()=>applyFilter(key)}><span className={`filter-preview ${key}`}><Sparkles size={12}/></span><small>{label}</small></button>)}</div>
 </div>;
 const drawMaskThumbnail=(canvas:HTMLCanvasElement,layer:Layer)=>{
  canvas.width=50;canvas.height=38;const ctx=canvas.getContext('2d');if(!ctx||!layer.mask)return;
  ctx.fillStyle='#111';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(layer.mask,0,0,canvas.width,canvas.height);
  if(!layer.maskEnabled){ctx.fillStyle='#0008';ctx.fillRect(0,0,canvas.width,canvas.height)}
 };
 const dropLayerOnRow=(event:React.DragEvent,layer:Layer)=>{
  event.preventDefault();event.stopPropagation();const sourceId=Number(event.dataTransfer.getData('application/x-pixelforge-layer'));
  if(!Number.isFinite(sourceId)||sourceId===layer.id)return;
  if(layer.type==='group'){moveLayerInTree(sourceId,layer.id,layers.filter(item=>item.parentId===layer.id).length);return}
  const source=layers.find(item=>item.id===sourceId);if(!source)return;
  const siblings=layers.filter(item=>item.parentId===layer.parentId),targetIndex=siblings.findIndex(item=>item.id===layer.id),rect=event.currentTarget.getBoundingClientRect(),after=event.clientY>=rect.top+rect.height/2;
  const insertionIndex=targetIndex+(after?1:0)-(source.parentId===layer.parentId&&siblings.findIndex(item=>item.id===sourceId)<targetIndex?1:0);
  moveLayerInTree(sourceId,layer.parentId,insertionIndex)
 };
 const dropLayerAtRoot=(event:React.DragEvent)=>{
  event.preventDefault();const sourceId=Number(event.dataTransfer.getData('application/x-pixelforge-layer'));
  if(Number.isFinite(sourceId))moveLayerInTree(sourceId,undefined,layers.filter(layer=>layer.parentId===undefined).length)
 };
 const renderLayerRows=(parentId?:number):React.ReactNode=>layers.filter(layer=>layer.parentId===parentId).slice().reverse().map(layer=>
  <div className="layer-tree-item" key={layer.id}>
   <div className={`layer-row ${active===layer.id?'active':''} ${selectedIds.includes(layer.id)?'multi-selected':''} ${layer.type==='group'?'group-row':''} ${layer.type==='adjustment'?'adjustment-row':''}`} onClick={event=>selectLayer(layer.id,event)} onDragStart={event=>{event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-pixelforge-layer',String(layer.id))}} onDragOver={event=>{event.preventDefault();event.dataTransfer.dropEffect='move'}} onDrop={event=>dropLayerOnRow(event,layer)} draggable>
    <button className="visibility" title={layer.visible?'Hide layer':'Show layer'} onClick={event=>{event.stopPropagation();setLayerProp(layer.id,'visible',!layer.visible)}}>{layer.visible?<Eye size={14}/>:<EyeOff size={14}/>}</button>
    {layer.type==='group'?<button className="tree-toggle" title={layer.expanded?'Collapse group':'Expand group'} onClick={event=>{event.stopPropagation();toggleGroup(layer.id)}}>{layer.expanded?<ChevronDown size={13}/>:<ChevronRight size={13}/>}</button>:null}
    <div className="layer-thumbnails">
     <button className={`layer-thumb ${tool==='mask'&&active===layer.id?'mask-editing':''}`} title={layer.type==='adjustment'?'Select adjustment layer':'Select layer pixels'} onClick={event=>{event.stopPropagation();setActive(layer.id);setSelectedIds([layer.id]);if(tool==='mask')setTool('brush')}}>
      {layer.type==='group'?<FolderOpen size={16}/>:layer.type==='adjustment'?<SlidersHorizontal size={15}/>:<canvas ref={el=>{if(el)drawLayerThumbnail(el,layer)}}/>}
     </button>
     {layer.mask&&<button className={`layer-mask-thumb ${tool==='mask'&&active===layer.id?'mask-editing':''}`} title={layer.maskEnabled?'Edit enabled layer mask':'Edit disabled layer mask'} onClick={event=>{event.stopPropagation();setActive(layer.id);setSelectedIds([layer.id]);setTool('mask')}}>
      <canvas ref={el=>{if(el)drawMaskThumbnail(el,layer)}}/>
     </button>}
    </div>
    {layer.mask&&<button className="mask-visibility" title={layer.maskEnabled?'Disable layer mask':'Enable layer mask'} onClick={event=>{event.stopPropagation();setLayerProp(layer.id,'maskEnabled',!layer.maskEnabled)}}>{layer.maskEnabled?<Eye size={12}/>:<EyeOff size={12}/>}</button>}
    <div className="layer-info">
     {renamingLayerId===layer.id?<input autoFocus value={renameDraft} onClick={event=>event.stopPropagation()} onChange={event=>setRenameDraft(event.target.value)} onBlur={()=>{renameLayer(layer.id,renameDraft);setRenamingLayerId(null)}} onKeyDown={event=>{if(event.key==='Enter'){renameLayer(layer.id,renameDraft);setRenamingLayerId(null)}if(event.key==='Escape')setRenamingLayerId(null)}}/>:<strong onDoubleClick={event=>{event.stopPropagation();if(layer.type==='text')openTextEditor(layer);else{setRenameDraft(layer.name);setRenamingLayerId(layer.id)}}}>{layer.name}</strong>}
     <small>{layer.type==='group'?`${layers.filter(item=>item.parentId===layer.id).length} layers`:layer.type==='adjustment'?`${layer.effects.length} editable effects`:layer.type==='text'?'Editable text':layer.type==='shape'?'Vector shape':layer.effects.length?'Pixel layer + effects':layer.filter==='none'?'Pixel layer':'Filtered layer'}</small>
    </div>
    <button className={`lock-btn ${layer.locked?'locked':''}`} title={layer.locked?'Unlock layer':'Lock layer'} onClick={event=>{event.stopPropagation();setLayerProp(layer.id,'locked',!layer.locked)}}>{layer.locked?<LockKeyhole size={13}/>:<LockKeyholeOpen size={13}/>}</button>
   </div>
   {layer.type==='group'&&layer.expanded&&<div className="layer-children">{renderLayerRows(layer.id)}</div>}
  </div>
 );
 const renderLayers=()=> <>
  <div className="layer-controls" onPointerDownCapture={beginPropertyGesture} onPointerUpCapture={finishPropertyGesture} onPointerCancelCapture={finishPropertyGesture} onKeyDownCapture={beginPropertyGesture} onKeyUpCapture={finishPropertyGesture} onBlurCapture={finishPropertyGesture}>
   <label>Blend<select value={current?.blend??'source-over'} onChange={event=>current&&setLayerProp(current.id,'blend',event.target.value)}><option value="source-over">Normal</option><option value="multiply">Multiply</option><option value="screen">Screen</option><option value="overlay">Overlay</option><option value="darken">Darken</option><option value="lighten">Lighten</option><option value="color-dodge">Color dodge</option><option value="soft-light">Soft light</option></select></label>
   <label>Opacity <b>{current?.opacity??100}%</b><input className="wide-range" type="range" min="0" max="100" value={current?.opacity??100} onChange={event=>current&&setLayerProp(current.id,'opacity',+event.target.value)}/></label>
  </div>
  <div className="layer-actions">
   <button title="New layer (Ctrl+Shift+N)" onClick={addLayer}><Plus size={15}/></button>
   <button title="Duplicate layer or group (Ctrl+J)" onClick={duplicateActiveLayer}><Copy size={14}/></button>
   <button title="Group selected layers" onClick={groupSelectedLayers}><FolderPlus size={14}/></button>
   <button title="Ungroup selected group" onClick={ungroupActiveLayer}><UnfoldHorizontal size={14}/></button>
   <button title="Rename layer" onClick={()=>{if(current){setRenameDraft(current.name);setRenamingLayerId(current.id)}}}><Pencil size={13}/></button>
   <button title="Move layer up" onClick={()=>changeLayerOrder(active,1)}><ArrowUp size={13}/></button>
   <button title="Move layer down" onClick={()=>changeLayerOrder(active,-1)}><ArrowDown size={13}/></button>
   <button title="Add layer mask" onClick={()=>createLayerMask()} disabled={!current||current.type==='group'||!!current.mask}><Aperture size={14}/></button>
   <button title="Add mask from current selection" onClick={createMaskFromSelection} disabled={!selection||!current||current.type==='group'||!!current.mask}><Aperture size={14}/></button>
   <button title="Merge selected adjacent layers" onClick={mergeSelectedLayers} disabled={selectedIds.length<2}><Layers size={14}/></button>
   <button title="Delete layer" onClick={deleteActiveLayer}><X size={15}/></button>
   <button title="Import image layer" onClick={upload}><ImagePlus size={15}/></button>
  </div>
  {current?.mask&&<div className="mask-controls">
   <div className="mask-heading"><strong>Layer mask</strong><span>{tool==='mask'?'Editing':'Preview'}</span></div>
   <div className="mask-actions">
    <button title={current.maskEnabled?'Disable mask':'Enable mask'} onClick={()=>setLayerProp(current.id,'maskEnabled',!current.maskEnabled)}>{current.maskEnabled?<Eye size={13}/>:<EyeOff size={13}/>} {current.maskEnabled?'Enabled':'Disabled'}</button>
    <button title="Invert mask" onClick={invertLayerMask}><ResetIcon size={13}/>Invert</button>
    <button title="Edit layer mask" onClick={()=>setTool('mask')}><Aperture size={13}/>Edit</button>
    <button title="Remove layer mask" onClick={removeLayerMask}><X size={13}/>Remove</button>
   </div>
   <div className="mask-actions">
    <button title="Paint mask black to conceal" onClick={()=>{setColor('#000000');setTool('mask')}}>Black</button>
    <button title="Paint mask white to reveal" onClick={()=>{setColor('#ffffff');setTool('mask')}}>White</button>
    <input aria-label="Mask grayscale value" title="Grayscale mask brush color" type="color" value={color} onChange={event=>{setColor(event.target.value);setTool('mask')}}/>
   </div>
   <small>Black conceals, white reveals, and gray gives partial coverage.</small>
  </div>}
  <div className="layers-list" onDragOver={event=>{event.preventDefault();event.dataTransfer.dropEffect='move'}} onDrop={dropLayerAtRoot}>{renderLayerRows()}</div>
 </>;
 const toolGroups:[Tool,string,any][][]=[[...tools.slice(0,6)],[...tools.slice(6,9)],[...tools.slice(9,14)],[...tools.slice(14,16)],[...tools.slice(16,23)],[tools[23]]];
 useEffect(()=>{if(tool==='gradient'||tool==='fill')setActivePanel('Fill')},[tool]);
 useEffect(()=>{const onKeyDown=(event:KeyboardEvent)=>{const target=event.target as HTMLElement;if(event.key.toLowerCase()!=='g'||event.ctrlKey||event.metaKey||event.altKey||target.closest('input,textarea,select,[contenteditable="true"]'))return;event.preventDefault();setTool(event.shiftKey?'fill':'gradient')};window.addEventListener('keydown',onKeyDown);return()=>window.removeEventListener('keydown',onKeyDown)},[]);
 return <div className={`app-shell ${isDragActive?'drop-active':''}`} onDragEnter={handleDragEnter} onDragLeave={handleDragLeave} onDragOver={handleDragOver} onDrop={handleDrop}>
 {isDragActive&&<div className="drop-overlay" role="status" aria-live="polite"><div className="drop-card"><ImagePlus size={28}/><strong>Drop image to add a layer</strong><span>PNG, JPEG, WebP, BMP, GIF</span></div></div>}
 <header className="menu-bar"><div className="brand"><div className="brand-mark"><Sparkles size={14}/></div><span>PixelForge</span><small>STUDIO</small></div><div className="menu-divider"/>{Object.keys(menuActions).map(name=><div className="menu-wrap" key={name}><button className={`menu-item ${openMenu===name?'menu-open':''}`} onClick={()=>setOpenMenu(openMenu===name?null:name)}>{name}</button>{openMenu===name&&<div className="menu-dropdown">{menuActions[name].map(([label,action])=><button key={label} onClick={()=>{action();setOpenMenu(null)}}>{label}</button>)}</div>}</div>)}<div className={`header-status ${currentDocument?.dirty?'modified':''}`}><span className="saved-dot"/>{currentDocument?.dirty?'Modified':'Saved'}</div><div className="top-actions"><button className="icon-btn" title="Undo (Ctrl+Z)" onClick={undo}><Undo2 size={15}/></button><button className="icon-btn" title="Redo (Ctrl+Y)" onClick={redo}><Redo2 size={15}/></button><div className="menu-divider"/><button className="export-btn" onClick={download}><ArrowDownToLine size={14}/> Export PNG</button><div className="avatar">PF</div></div></header>
<div className="options-bar"><div className="option-tool">{(()=>{const Icon=tools.find(item=>item[0]===tool)?.[2];return Icon?<Icon size={15}/>:null})()}<b>{tools.find(item=>item[0]===tool)?.[1]}</b></div>{tool==='crop'?<><div className="option-divider"/><select aria-label="Crop aspect ratio" value={['free','original','1:1','4:3','3:2','16:9'].includes(cropRatio)?cropRatio:'custom'} onChange={e=>{if(e.target.value==='custom'){const value=window.prompt('Custom ratio, for example 5:4','5:4');if(value&&/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(value))setCropRatio(value)}else setCropRatio(e.target.value)}}><option value="free">Free</option><option value="original">Original</option><option value="1:1">1:1</option><option value="4:3">4:3</option><option value="3:2">3:2</option><option value="16:9">16:9</option><option value="custom">Custom ratio</option></select>{(['x','y','width','height'] as const).map(key=><label className="option-field crop-field" key={key}>{key.toUpperCase()}<input aria-label={`Crop ${key}`} type="number" value={cropRect?Math.round(cropRect[key]):key==='width'?size.w:key==='height'?size.h:0} onChange={e=>setCropDimension(key,Number(e.target.value))}/></label>)}<button className="modal-primary crop-apply" onClick={applyCrop} disabled={!cropRect}>Apply</button><button className="modal-secondary crop-cancel" onClick={cancelCrop}>Cancel</button></>:tool==='move'&&current?<><div className="option-divider"/>{(['x','y','width','height','rotation'] as const).map(key=><label className="option-field transform-field" key={key}>{key==='rotation'?'Angle':key.toUpperCase()}<input aria-label={`Layer ${key}`} type="number" value={Math.round(current[key]??0)} onFocus={beginTransformEdit} onChange={e=>applyTransform({[key]:Number(e.target.value)})} onBlur={endTransformEdit}/>{key==='rotation'?'deg':'px'}</label>)}<span className="option-spacer"/><button className="icon-btn compact" title="Flip active layer horizontally" onClick={()=>flip(true)}><ArrowLeftRight size={14}/></button></>:['marquee','ellipseSelect','rowSelect','columnSelect','lasso','polygonLasso','wand'].includes(tool)?<><div className="option-divider"/><select aria-label="Selection mode" value={selectionMode} onChange={e=>setSelectionMode(e.target.value as SelectionMode)}><option value="replace">New selection</option><option value="add">Add to selection</option><option value="subtract">Subtract</option><option value="intersect">Intersect</option></select><label className="option-field">Feather <input aria-label="Selection feather" type="number" min="0" max="64" value={selectionFeather} onChange={e=>setSelectionFeather(Math.max(0,Math.min(64,+e.target.value)))}/><span>px</span></label>{tool!=='rowSelect'&&tool!=='columnSelect'&&<label className="option-check"><input type="checkbox" checked={selectionAA} onChange={e=>setSelectionAA(e.target.checked)}/>Anti-alias</label>}{tool==='wand'&&<><label className="option-field">Tolerance <input aria-label="Magic wand tolerance" type="range" min="0" max="255" value={wandTolerance} onChange={e=>setWandTolerance(+e.target.value)}/><span>{wandTolerance}</span></label><label className="option-check"><input type="checkbox" checked={wandContiguous} onChange={e=>setWandContiguous(e.target.checked)}/>Contiguous</label><label className="option-check"><input type="checkbox" checked={wandSampleMerged} onChange={e=>setWandSampleMerged(e.target.checked)}/>Sample merged</label></>}<span className="option-spacer"/><span className="option-label selection-dim-label">{selection?.bounds?`${selection.bounds.width} x ${selection.bounds.height} px`:'No selection'}</span><button className="icon-btn compact" onClick={()=>setShowSelection(value=>!value)} title="Toggle selection outline">{showSelection?<Eye size={14}/>:<EyeOff size={14}/>}</button></>:tool==='text'?<><div className="option-divider"/><label className="option-field">Font <select aria-label="Text font family" value={current?.type==='text'?current.textData?.fontFamily??'Segoe UI':'Segoe UI'} onChange={e=>updateTextProperties({fontFamily:e.target.value})}><option>Segoe UI</option><option>Arial</option><option>Calibri</option><option>Cambria</option><option>Consolas</option><option>Georgia</option><option>Tahoma</option><option>Times New Roman</option><option>Verdana</option></select></label><label className="option-field">Size <input aria-label="Text font size" type="number" min="1" max="2000" value={current?.type==='text'?current.textData?.fontSize??48:48} onChange={e=>updateTextProperties({fontSize:Math.max(1,+e.target.value)})}/></label><label className="option-field">Weight <select aria-label="Text font weight" value={current?.type==='text'?current.textData?.fontWeight??400:400} onChange={e=>updateTextProperties({fontWeight:+e.target.value as TextLayerData['fontWeight']})}><option value="400">Regular</option><option value="500">Medium</option><option value="600">Semibold</option><option value="700">Bold</option><option value="800">Extra bold</option><option value="900">Black</option></select></label><label className="option-field">Align <select aria-label="Text alignment" value={current?.type==='text'?current.textData?.alignment??'left':'left'} onChange={e=>updateTextProperties({alignment:e.target.value as TextLayerData['alignment']})}><option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option></select></label><button className="modal-secondary" onClick={()=>openTextEditor(current?.type==='text'?current:undefined)}>More text options</button><span className="option-spacer"/><span className="option-label">Colour</span><input className="inline-color" aria-label="Text colour" type="color" value={current?.type==='text'?current.textData?.color??color:color} onChange={e=>current?.type==='text'?updateTextProperties({color:e.target.value}):setColor(e.target.value)}/></>:isShapeTool(tool)?<><div className="option-divider"/><label className="option-check"><input aria-label="Shape fill enabled" type="checkbox" checked={current?.type==='shape'?current.shapeData?.fillEnabled??shapeDefaults.fillEnabled:shapeDefaults.fillEnabled} onChange={e=>setShapeSettings({fillEnabled:e.target.checked})}/>Fill</label><input className="inline-color" aria-label="Shape fill colour" type="color" value={current?.type==='shape'?current.shapeData?.fill??shapeDefaults.fill:shapeDefaults.fill} onChange={e=>setShapeSettings({fill:e.target.value})}/><label className="option-check"><input aria-label="Shape stroke enabled" type="checkbox" checked={current?.type==='shape'?current.shapeData?.strokeEnabled??shapeDefaults.strokeEnabled:shapeDefaults.strokeEnabled} onChange={e=>setShapeSettings({strokeEnabled:e.target.checked})}/>Stroke</label><input className="inline-color" aria-label="Shape stroke colour" type="color" value={current?.type==='shape'?current.shapeData?.stroke??shapeDefaults.stroke:shapeDefaults.stroke} onChange={e=>setShapeSettings({stroke:e.target.value})}/><label className="option-field">Width <input aria-label="Stroke width" type="number" min="0" max="100" value={current?.type==='shape'?current.shapeData?.strokeWidth??shapeDefaults.strokeWidth:shapeDefaults.strokeWidth} onChange={e=>setShapeSettings({strokeWidth:Math.max(0,+e.target.value)})}/></label>{tool==='roundedRectangle'&&<label className="option-field">Radius <input aria-label="Corner radius" type="number" min="0" max="500" value={current?.type==='shape'?current.shapeData?.cornerRadius??shapeDefaults.cornerRadius:shapeDefaults.cornerRadius} onChange={e=>setShapeSettings({cornerRadius:+e.target.value})}/></label>}{tool==='polygon'&&<label className="option-field">Sides <input aria-label="Polygon sides" type="number" min="3" max="20" value={current?.type==='shape'?current.shapeData?.sides??shapeDefaults.sides:shapeDefaults.sides} onChange={e=>setShapeSettings({sides:Math.max(3,+e.target.value)})}/></label>}{tool==='star'&&<label className="option-field">Points <input aria-label="Star points" type="number" min="2" max="20" value={current?.type==='shape'?current.shapeData?.points??shapeDefaults.points:shapeDefaults.points} onChange={e=>setShapeSettings({points:Math.max(2,+e.target.value)})}/></label>}<span className="option-spacer"/><span className="option-label">Shift: constrain | Alt: draw from centre</span></>:<><div className="option-divider"/><label className="option-field">Size <input type="range" min="1" max="500" value={brushSize} onChange={e=>setBrushSize(+e.target.value)}/><span>{brushSize} px</span></label>{['brush','eraser','mask'].includes(tool)&&<><label className="option-field">Hardness <input type="range" min="0" max="100" value={hardness} onChange={e=>setHardness(+e.target.value)}/><span>{hardness}%</span></label><label className="option-field">Flow <input type="range" min="1" max="100" value={flow} onChange={e=>setFlow(+e.target.value)}/><span>{flow}%</span></label><button className="icon-btn compact" title="Brush settings" onClick={()=>setActivePanel('Brush')}><SlidersHorizontal size={14}/></button></>}{['brush','eraser','mask','rectangle','ellipse'].includes(tool)&&<label className="option-field">Opacity <input type="range" min="1" max="100" value={opacity} onChange={e=>setOpacity(+e.target.value)}/><span>{opacity}%</span></label>}<span className="option-spacer"/>{['brush','eraser','mask','rectangle','ellipse','text'].includes(tool)&&<><span className="option-label">Foreground</span><input className="inline-color" aria-label="Foreground colour" type="color" value={color} onChange={e=>setColor(e.target.value)}/></>}</>}</div>
<div className="document-bar"><div className="document-tabs">{documents.map(doc=><div key={doc.id} className={`doc-tab ${doc.id===activeDocumentId?'active':''}`} onClick={()=>doc.id!==activeDocumentId&&activateDocument(doc)}><FileImage size={14}/>{renaming&&doc.id===activeDocumentId?<input value={title} onChange={event=>setTitle(event.target.value)} onBlur={commitDocumentRename} autoFocus/>:<span onDoubleClick={event=>{event.stopPropagation();setRenaming(true)}} title="Double-click to rename">{doc.name}</span>}{doc.dirty&&<span className="doc-dirty" title="Unsaved changes"/>}<button className="tiny-x" title="Close document" onClick={event=>{event.stopPropagation();closeDocument(doc)}}><X size={12}/></button></div>)}</div><button className="doc-plus" title="New document" onClick={newDoc}><Plus size={14}/></button><span className="doc-meta">{size.w} x {size.h} px | {currentDocument?.resolution??72} ppi | RGB / 8</span><div className="doc-tab-tools"><button className="icon-btn compact" title="Import image layer" onClick={upload}><ImagePlus size={14}/></button><button className="icon-btn compact" title="Export PNG" onClick={download}><ArrowDownToLine size={14}/></button></div></div>
 <main className="workspace"><aside className="toolbar">{toolGroups.map((group,gi)=><div className="tool-group" key={gi}>{group.map(([id,label,Icon])=><button key={`${id}-${label}`} className={`tool-button ${tool===id?'selected':''}`} title={`${label} ? ${id==='brush'?'B':id==='eraser'?'E':id==='text'?'T':id==='move'?'V':''}`} onClick={()=>{setTool(id);if(isShapeTool(id))setShapeDefaults(value=>({...value,kind:id as VectorShapeKind,...(id==='line'?{fillEnabled:false,strokeEnabled:true}: {})}));if(id==='crop')setCropRect({x:0,y:0,width:size.w,height:size.h})}}><Icon size={17}/><span>{label}</span></button>)}</div>)}<div className="tool-spacer"/><button className="color-stack" title="Swap foreground and background" onClick={()=>{const n=color;setColor(bg);changeBackground(n)}}><span style={{background:color}}/><i style={{background:bg}}/></button><button className="reset-colors" title="Reset colours" onClick={()=>{setColor('#111111');changeBackground('#ffffff')}}>Default colours</button></aside>
 <section className="center-workspace"><div className="canvas-area" ref={stageRef}><div className="canvas-frame" style={{width:`${size.w*zoom/100}px`,height:`${size.h*zoom/100}px`,background:currentDocument?.transparent?"#2b2c2f":bg,backgroundImage:currentDocument?.transparent?"linear-gradient(45deg,#303134 25%,transparent 25%),linear-gradient(-45deg,#303134 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#303134 75%),linear-gradient(-45deg,transparent 75%,#303134 75%)":undefined,backgroundSize:"18px 18px",backgroundPosition:"0 0,0 9px,9px -9px,-9px 0"}}><canvas ref={viewRef} style={{width:'100%',height:'100%',opacity:channelView==='rgb'?1:0,filter:`brightness(${adjust.brightness}%) contrast(${adjust.contrast}%) saturate(${adjust.saturate}%) blur(${adjust.blur}px)`}} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerLeave={pointerLeave} onPointerEnter={e=>{const p=point(e);setBrushCursor({x:p.x,y:p.y,visible:['brush','eraser','mask'].includes(tool),pressure:pressureFromEvent(e)})}}/><canvas ref={channelViewRef} className="channel-preview" style={{filter:`brightness(${adjust.brightness}%) contrast(${adjust.contrast}%) saturate(${adjust.saturate}%) blur(${adjust.blur}px)`}} aria-hidden="true"/><canvas ref={selectionViewRef} className="selection-ants" aria-hidden="true"/><canvas ref={pathViewRef} className="path-overlay" aria-hidden="true"/>{shapeDraft&&<svg className="shape-preview" viewBox={`0 0 ${size.w} ${size.h}`} aria-hidden="true"><rect x={shapeDraft.x} y={shapeDraft.y} width={shapeDraft.width} height={shapeDraft.height} fill={shapeDefaults.fillEnabled?shapeDefaults.fill:'none'} fillOpacity=".22" stroke={shapeDefaults.strokeEnabled?shapeDefaults.stroke:'#1684e8'} strokeWidth={Math.max(1/Math.max(.1,zoom/100),shapeDefaults.strokeWidth)} strokeDasharray="5 3"/></svg>}{tool==='move'&&current&&!current.locked&&<svg className="transform-overlay" viewBox={`0 0 ${size.w} ${size.h}`} aria-hidden="true"><rect x={current.x} y={current.y} width={current.width} height={current.height} fill="none" stroke="#42a5ff" strokeWidth={1/Math.max(.1,zoom/100)} vectorEffect="non-scaling-stroke"/><rect x={current.x+current.width-5/Math.max(.1,zoom/100)} y={current.y+current.height-5/Math.max(.1,zoom/100)} width={10/Math.max(.1,zoom/100)} height={10/Math.max(.1,zoom/100)} fill="#fff" stroke="#1684e8"/></svg>}{tool==='crop'&&cropRect&&<svg className="crop-overlay" viewBox={`0 0 ${size.w} ${size.h}`} aria-hidden="true"><path d={`M0 0H${size.w}V${size.h}H0Z M${cropRect.x} ${cropRect.y}h${cropRect.width}v${cropRect.height}h-${cropRect.width}Z`} fill="#000" fillOpacity=".48" fillRule="evenodd"/><rect x={cropRect.x} y={cropRect.y} width={cropRect.width} height={cropRect.height} fill="none" stroke="#f4f4f4" strokeWidth={1/Math.max(.1,zoom/100)} strokeDasharray={`${5/Math.max(.1,zoom/100)} ${3/Math.max(.1,zoom/100)}`} vectorEffect="non-scaling-stroke"/>{[[cropRect.x,cropRect.y],[cropRect.x+cropRect.width,cropRect.y],[cropRect.x,cropRect.y+cropRect.height],[cropRect.x+cropRect.width,cropRect.y+cropRect.height]].map(([x,y],i)=><rect key={i} x={x-5/Math.max(.1,zoom/100)} y={y-5/Math.max(.1,zoom/100)} width={10/Math.max(.1,zoom/100)} height={10/Math.max(.1,zoom/100)} fill="#fff" stroke="#1684e8" strokeWidth={1/Math.max(.1,zoom/100)}/>)}</svg>}{brushCursor.visible&&['brush','eraser','mask'].includes(tool)&&<div className="brush-cursor" style={{left:`${brushCursor.x*zoom/100}px`,top:`${brushCursor.y*zoom/100}px`,width:`${brushSize*(pressureSize?brushCursor.pressure:1)*zoom/100}px`,height:`${brushSize*(pressureSize?brushCursor.pressure:1)*zoom/100}px`}} aria-hidden="true"/>}{polygonPoints.length>0&&<svg className="selection-preview" viewBox={`0 0 ${size.w} ${size.h}`} aria-hidden="true"><polyline points={[...polygonPoints,...(polygonCursor?[polygonCursor]:[])].map(p=>`${p.x},${p.y}`).join(" ")} fill="none" stroke="#58a6ff" strokeWidth={1/Math.max(.1,zoom/100)} strokeDasharray="4 3"/></svg>}</div><div className="canvas-hint">{tool==='brush'?'Drag to paint':tool==='marquee'||tool==='ellipseSelect'?'Drag to create a selection':tool==='lasso'?'Draw around an area':tool==='polygonLasso'?'Click points; Enter to close':tool==='wand'?'Click a colour to select similar pixels':tool==='text'?'Click to place type':tool==='mask'?'Paint black to conceal pixels':tool==='crop'?'Drag to define crop; drag inside to reposition':'Drag on the canvas'}</div></div>
 <footer className="statusbar"><div className="status-left"><span className="status-dot"/>Ready <i/>{activeName}{selection?.bounds&&<><i/>Selection {selection.bounds.width} x {selection.bounds.height}</>}</div><div className="zoom-controls"><button title="Zoom out" onClick={()=>setZoom(value=>Math.max(10,value-5))}><Minus size={12}/></button><input aria-label="Canvas zoom" type="range" min="10" max="150" value={zoom} onChange={e=>setZoom(+e.target.value)}/><button title="Zoom in" onClick={()=>setZoom(value=>Math.min(150,value+5))}><Plus size={12}/></button><span>{zoom}%</span><button className="fit-btn" onClick={()=>setZoom(Math.min(100,Math.round(Math.min((window.innerWidth-420)/size.w,(window.innerHeight-240)/size.h)*100)))}>Fit</button></div><div className="status-right">{size.w} x {size.h} px</div></footer></section>
 <aside className="inspector"><div className="panel-tabs">{['Layers','Channels','Paths','History'].map((p,i)=><button key={p} className={`panel-tab ${activePanel===p?'active':''}`} title={p} onClick={()=>setActivePanel(p)}>{p==='Layers'?<Layers size={13}/>:p==='Channels'?<Circle size={13}/>:p==='Paths'?<Shapes size={13}/>:<RotateCcw size={13}/>}<span>{p}</span></button>)}</div><div className="panel-dock-tabs">{['Properties','Color','Swatches','Adjustments','Brush','Fill','Retouch'].map(p=><button key={p} className={activePanel===p?'active':''} onClick={()=>{setActivePanel(p);if(p==='Fill'&&tool!=='gradient'&&tool!=='fill')setTool('fill')}}>{p}</button>)}</div><div className="panel-scroll">
 {activePanel==='Layers'&&<><div className="panel-section"><div className="panel-heading"><span>LAYERS <em>{layerCount}</em></span><button className="quiet-icon" title="Layer settings" onClick={()=>setActivePanel('Properties')}><Settings2 size={14}/></button></div>{renderLayers()}</div><div className="panel-section compact-section"><div className="panel-heading"><span>QUICK ACTIONS</span></div><button className="wide-action" onClick={()=>{if(current){setTool('mask');announce('Mask brush selected')}}}><Aperture size={14}/> Add layer mask <Plus size={13}/></button></div></>}
 {activePanel==='Fill'&&<div className="panel-section fill-panel">
  <div className="panel-heading"><span>{tool==='gradient'?'GRADIENT TOOL':'FLOOD FILL'}</span><small>{tool==='gradient'?'G':'Shift+G'}</small></div>
  {tool==='gradient'?<>
   <label className="property-label">Gradient type<select aria-label="Gradient type" value={gradientKind} onChange={event=>setGradientKind(event.target.value as GradientKind)}><option value="linear">Linear</option><option value="radial">Radial</option></select></label>
   <label className="property-label">Preset<select aria-label="Gradient preset" value={gradientPreset} onChange={event=>{const preset=event.target.value as typeof gradientPreset;if(preset==='custom'&&!customGradientInitialized.current){setGradientStops([{position:0,color,opacity:100},{position:1,color:bg,opacity:100}]);customGradientInitialized.current=true}setGradientPreset(preset)}}><option value="foreground-background">Foreground to background</option><option value="foreground-transparent">Foreground to transparent</option><option value="custom">Custom stops</option></select></label>
   {gradientPreset==='custom'&&<div className="gradient-stop-list">{gradientStops.map((stop,index)=><div className="gradient-stop" key={`${index}-${stop.position}`}><input aria-label={`Gradient stop ${index+1} colour`} title={`Stop ${index+1} colour`} type="color" value={stop.color} onChange={event=>updateGradientStop(index,{color:event.target.value})}/><label>Position<input aria-label={`Gradient stop ${index+1} position`} type="range" min="0" max="100" value={Math.round(stop.position*100)} onChange={event=>updateGradientStop(index,{position:+event.target.value/100})}/><span>{Math.round(stop.position*100)}%</span></label><label>Opacity<input aria-label={`Gradient stop ${index+1} opacity`} type="range" min="0" max="100" value={stop.opacity} onChange={event=>updateGradientStop(index,{opacity:+event.target.value})}/><span>{stop.opacity}%</span></label><button className="quiet-icon" title="Remove gradient stop" aria-label={`Remove gradient stop ${index+1}`} disabled={gradientStops.length<=2} onClick={()=>{setGradientStops(items=>items.filter((_,itemIndex)=>itemIndex!==index));setGradientPreset('custom')}}><X size={12}/></button></div>)}</div>}
   {gradientPreset==='custom'&&<button className="wide-action" disabled={gradientStops.length>=16} onClick={addGradientStop}><Plus size={13}/> Add colour stop</button>}
  </>:<>
   <label className="property-label">Fill with<select aria-label="Flood-fill source" value={fillSource} onChange={event=>setFillSource(event.target.value as typeof fillSource)}><option value="foreground">Foreground colour</option><option value="background">Background colour</option></select></label>
   <label className="property-label">Tolerance <input aria-label="Flood-fill tolerance" type="range" min="0" max="255" value={floodTolerance} onChange={event=>setFloodTolerance(+event.target.value)}/><span>{floodTolerance}</span></label>
   <label className="option-check"><input type="checkbox" checked={floodContiguous} onChange={event=>setFloodContiguous(event.target.checked)}/>Contiguous region only</label>
   <label className="option-check"><input type="checkbox" checked={floodAntiAlias} onChange={event=>setFloodAntiAlias(event.target.checked)}/>Anti-alias edges</label>
  </>}
  <label className="property-label">Opacity <input aria-label="Fill opacity" type="range" min="0" max="100" value={fillOpacity} onChange={event=>setFillOpacity(+event.target.value)}/><span>{fillOpacity}%</span></label>
  <label className="property-label">Blend mode<select aria-label="Fill blend mode" value={fillBlend} onChange={event=>setFillBlend(event.target.value as FillBlendMode)}>{[['source-over','Normal'],['multiply','Multiply'],['screen','Screen'],['overlay','Overlay'],['darken','Darken'],['lighten','Lighten'],['color-dodge','Colour dodge'],['soft-light','Soft light']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
  <label className="property-label">Apply to<select aria-label="Fill target" value={fillTarget} onChange={event=>setFillTarget(event.target.value as typeof fillTarget)}><option value="pixels">Layer pixels</option><option value="mask" disabled={!current?.mask}>Layer mask</option></select></label>
  <small>{tool==='gradient'?'Drag across the canvas to set gradient direction.':'Click a pixel region to fill it.'}{selection?' Current selection limits the result.':' The active layer must be visible and unlocked.'}</small>
 </div>}
 {activePanel==='Retouch'&&<div className="panel-section fill-panel retouch-panel">
  <div className="panel-heading"><span>{tool==='healing'?'HEALING BRUSH':'CLONE STAMP'}</span><small>{tool==='healing'?'J':'S'}</small></div>
  <div className="empty-panel">{retouchSourcePoint?'Alt-click to set a new source point.':'Alt-click the canvas to choose a source point.'} Drag to retouch; each stroke is one undo step.</div>
  <label className="property-label">Sample<select aria-label="Retouch sample source" value={retouchSourceMode} disabled={retouchTarget==='mask'} onChange={event=>setRetouchSourceMode(event.target.value as RetouchSourceMode)}><option value="active">Active layer</option><option value="merged">Merged visible image</option></select></label>
  <label className="option-check"><input aria-label="Aligned retouch sampling" type="checkbox" checked={retouchAligned} onChange={event=>{setRetouchAligned(event.target.checked);retouchTargetAnchor.current=null}}/>Aligned source</label>
  <label className="property-label">Source offset X<input aria-label="Retouch source offset X" type="number" value={retouchOffsetX} onChange={event=>setRetouchOffsetX(Math.max(-MAX_DOCUMENT_DIMENSION,Math.min(MAX_DOCUMENT_DIMENSION,Number(event.target.value)||0)))}/><span>px</span></label>
  <label className="property-label">Source offset Y<input aria-label="Retouch source offset Y" type="number" value={retouchOffsetY} onChange={event=>setRetouchOffsetY(Math.max(-MAX_DOCUMENT_DIMENSION,Math.min(MAX_DOCUMENT_DIMENSION,Number(event.target.value)||0)))}/><span>px</span></label>
  <label className="property-label">Apply to<select aria-label="Retouch target" value={retouchTarget} onChange={event=>{const target=event.target.value as RetouchTarget;setRetouchTarget(target);if(target==='mask')setRetouchSourceMode('active');retouchTargetAnchor.current=null}}><option value="pixels">Layer pixels</option><option value="mask" disabled={!current?.mask}>Layer mask</option></select></label>
  <label className="property-label">Hardness<input aria-label="Retouch brush hardness" type="range" min="0" max="100" value={hardness} onChange={event=>setHardness(+event.target.value)}/><span>{hardness}%</span></label>
  <label className="property-label">Opacity<input aria-label="Retouch brush opacity" type="range" min="1" max="100" value={opacity} onChange={event=>setOpacity(+event.target.value)}/><span>{opacity}%</span></label>
  <label className="property-label">Flow<input aria-label="Retouch brush flow" type="range" min="1" max="100" value={flow} onChange={event=>setFlow(+event.target.value)}/><span>{flow}%</span></label>
  <button className="wide-action" onClick={()=>setActivePanel('Brush')}><SlidersHorizontal size={13}/> Brush size, hardness, opacity &amp; flow</button>
  <small>{retouchTarget==='mask'?'The mask is cloned directly; merged-image sampling is disabled.':'Selections and enabled layer masks limit the stroke.'} Healing transfers source texture and adapts its local mean colour to the destination.</small>
 </div>}
 {activePanel==='Adjustments'&&<div className="panel-section">{renderAdjustments()}</div>}{activePanel==='Brush'&&<div className="panel-section brush-panel">{renderBrushPanel()}</div>}
{activePanel==='Properties'&&<div className="panel-section">
 <div className="panel-heading"><span>ACTIVE LAYER</span></div>
 <div className="property-card">
  <small>Name</small><b className="property-value">{activeName}</b>
  <small>Dimensions</small><b className="property-value">{size.w} x {size.h} px</b>
  <small>Type</small><b className="property-value">{current?.type==='adjustment'?'Adjustment layer':current?.type==='text'?'Editable text':current?.type==='shape'?'Vector shape':current?.type==='group'?'Layer group':current?.filter==='none'?'Pixel layer':'Filtered layer'}</b>
 </div>
 <div className="panel-heading section-gap"><span>APPEARANCE</span></div>
 <label className="property-label">Opacity <b>{current?.opacity??100}%</b></label>
 <input className="wide-range" type="range" min="0" max="100" value={current?.opacity??100} onChange={e=>current&&setLayerProp(current.id,'opacity',+e.target.value)}/>
 {current?.type==='text'&&current.textData&&<><div className="panel-heading section-gap"><span>TYPE</span><button className="quiet-button" onClick={()=>openTextEditor(current)}>Edit text</button></div><div className="property-card"><small>Font</small><b className="property-value">{current.textData.fontFamily}, {current.textData.fontSize}px</b><small>Paragraph</small><b className="property-value">{current.textData.alignment} ? {current.textData.content.split('\n').length} lines</b></div></>}
 {current?.type==='shape'&&current.shapeData&&<><div className="panel-heading section-gap"><span>VECTOR SHAPE</span></div><div className="property-card"><small>Kind</small><b className="property-value">{current.shapeData.kind}</b><small>Fill / stroke</small><b className="property-value">{current.shapeData.fillEnabled?current.shapeData.fill:'None'} / {current.shapeData.strokeEnabled?current.shapeData.stroke:'None'}</b></div></>}
</div>}
 {activePanel==='Color'&&<div className="panel-section"><div className="panel-heading"><span>FOREGROUND COLOR</span></div><div className="color-editor"><input type="color" value={color} onChange={e=>setColor(e.target.value)}/><input value={color.toUpperCase()} onChange={e=>/^#[0-9A-Fa-f]{6}$/.test(e.target.value)&&setColor(e.target.value)} aria-label="Hex colour"/><span className="color-chip" style={{background:color}}/></div><div className="panel-heading section-gap"><span>BACKGROUND COLOR</span></div><div className="color-editor"><input type="color" value={bg} onChange={e=>changeBackground(e.target.value)}/><input value={bg.toUpperCase()} onChange={e=>/^#[0-9A-Fa-f]{6}$/.test(e.target.value)&&changeBackground(e.target.value)} aria-label="Canvas background colour"/></div></div>}
 {activePanel==='Swatches'&&<div className="panel-section"><div className="panel-heading"><span>DEFAULT SWATCHES</span></div><div className="swatch-grid">{['#111111','#ffffff','#7f9cf5','#2f80ed','#20b486','#e4b74d','#e7784b','#d65b78','#9b77d4','#686b73','#a8b3c2','#32547c'].map(c=><button key={c} title={c} style={{background:c}} onClick={()=>setColor(c)}/>)}</div></div>}
 {activePanel==='Channels'&&<div className="panel-section"><div className="panel-heading"><span>CHANNELS</span><em>Preview only</em></div>{([['rgb','RGB Composite'],['red','Red'],['green','Green'],['blue','Blue'],['alpha','Alpha / Transparency']] as [ChannelView,string][]).map(([id,name])=><button type="button" className={`channel-row ${channelView===id?'active':''}`} aria-pressed={channelView===id} key={id} onClick={()=>setChannelView(id)}><span className={`channel-swatch ${id}`}/><b>{name}</b>{channelView===id?<Eye size={13}/>:<span className="channel-indicator"/>}</button>)}<div className="empty-panel">Channel previews do not edit pixels or affect layers, masks, selections, or undo history.</div></div>}
 {activePanel==='Paths'&&<><div className="panel-section"><div className="panel-heading"><span>PATHS <em>{paths.length}</em></span><button className="quiet-icon" title="Create empty path" onClick={createPath}><Plus size={14}/></button></div><div className="path-actions"><button className="wide-action" disabled={!selection} onClick={addSelectionToPath}>Selection to path</button><button className="wide-action" disabled={!supportsPathFromLayer(current)} onClick={addShapeToPath}>Shape to path</button><button className="wide-action" disabled={!activePathId} onClick={()=>setActivePathId(null)}>Deselect path</button></div>{paths.length===0?<div className="empty-panel">Create a path, or convert the current selection or a vector shape. Select a path to show its outline; double-click its name to rename.</div>:<div className="paths-list">{paths.map(path=><div key={path.id} className={`path-row ${activePathId===path.id?'active':''}`}><button className="visibility" type="button" title={path.visible?'Hide path':'Show path'} aria-label={`${path.visible?'Hide':'Show'} ${path.name}`} onClick={()=>togglePathVisibility(path)}>{path.visible?<Eye size={14}/>:<EyeOff size={14}/>}</button>{renamingPathId===path.id?<input className="path-name-input" autoFocus value={pathNameDraft} onClick={event=>event.stopPropagation()} onChange={event=>setPathNameDraft(event.target.value)} onBlur={()=>{renamePath(path.id,pathNameDraft);setRenamingPathId(null)}} onKeyDown={event=>{if(event.key==='Enter'){renamePath(path.id,pathNameDraft);setRenamingPathId(null)}if(event.key==='Escape')setRenamingPathId(null)}}/>:<button type="button" className="path-name" onClick={()=>setActivePathId(path.id)} onDoubleClick={event=>{event.stopPropagation();setPathNameDraft(path.name);setRenamingPathId(path.id)}}>{path.name}</button>}<button className="quiet-icon" type="button" title={`Delete ${path.name}`} aria-label={`Delete ${path.name}`} onClick={()=>removePath(path.id)}><X size={13}/></button></div>)}</div>}</div><div className="panel-section"><div className="panel-heading"><span>SELECTION</span><button className="quiet-icon" onClick={()=>setShowSelection(v=>!v)} title="Toggle outline">{showSelection?<Eye size={14}/>:<EyeOff size={14}/>}</button></div><div className="property-card"><small>Bounds and size (pixels)</small><div className="selection-dimensions"><label>X<input type="number" min="0" max={size.w-1} value={exactX} onChange={e=>setExactX(+e.target.value)}/></label><label>Y<input type="number" min="0" max={size.h-1} value={exactY} onChange={e=>setExactY(+e.target.value)}/></label><label>W<input type="number" min="1" max={size.w} value={exactWidth} onChange={e=>setExactWidth(+e.target.value)}/></label><label>H<input type="number" min="1" max={size.h} value={exactHeight} onChange={e=>setExactHeight(+e.target.value)}/></label></div><button className="wide-action" onClick={applyExactSelection}>Apply rectangular bounds</button><button className="wide-action" onClick={invertCurrentSelection}>Invert selection</button><button className="wide-action" onClick={clearSelection}>Deselect</button><button className="wide-action" onClick={clearSelectedPixels}>Clear selected pixels</button><button className="wide-action" onClick={createMaskFromSelection}>Create mask from selection</button></div></div></>}
{activePanel==='History'&&<div className="panel-section"><div className="panel-heading"><span>HISTORY <em>{historyRef.current.history.cursor}/{historyRef.current.history.entries.length}</em></span><select aria-label="History limit" value={historyLimit} onChange={event=>{const limit=+event.target.value;setHistoryLimit(limit);setHistory(activeDocumentId,trimHistory(historyRef.current.history,limit))}}><option value={20}>20</option><option value={60}>60</option><option value={100}>100</option></select></div><div className="history-list"><button className={`history-row ${historyRef.current.history.cursor===0?'active':''}`} onClick={()=>jumpHistory(0)}><span className="history-dot"/><div><b>Document opened</b><small>{currentDocument?.name} | {size.w} x {size.h} px</small></div></button>{historyRef.current.history.entries.map((entry,index)=><button key={entry.id} className={`history-row ${historyRef.current.history.cursor===index+1?'active':''}`} onClick={()=>jumpHistory(index+1)}><span className="history-dot"/><div><b>{entry.label}</b><small>{new Date(entry.timestamp).toLocaleTimeString()} | {(entry.memoryBytes/1024).toFixed(1)} KB</small></div></button>)}</div><div className="history-buttons"><button disabled={!historyCanUndo(historyRef.current.history)} onClick={undo}><Undo2 size={13}/> Undo</button><button disabled={!historyCanRedo(historyRef.current.history)} onClick={redo}><Redo2 size={13}/> Redo</button></div></div>}
 </div><div className="panel-bottom"><span className="status-dot"/>PixelForge Studio<span>v1.0.0</span></div></aside></main>{openMenu&&<button className="menu-dismiss" aria-label="Close menu" onClick={()=>setOpenMenu(null)}/>} {toast&&<div className="toast"><span/> {toast}</div>}{newDocOpen&&<div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setNewDocOpen(false)}}><form className="document-modal" role="dialog" aria-modal="true" aria-labelledby="new-document-title" onSubmit={event=>{event.preventDefault();createNewDoc()}} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();setNewDocOpen(false)}}}><div className="document-modal-header"><h2 id="new-document-title">New document</h2><button type="button" className="quiet-icon" aria-label="Close new document dialog" onClick={()=>setNewDocOpen(false)}><X size={14}/></button></div><p>Set canvas dimensions in pixels.</p><div className="document-modal-fields"><label>Width<input autoFocus aria-label="Canvas width" type="number" min="1" max="30000" value={newDocWidth} onChange={event=>setNewDocWidth(event.target.value)}/></label><label>Height<input aria-label="Canvas height" type="number" min="1" max="30000" value={newDocHeight} onChange={event=>setNewDocHeight(event.target.value)}/></label></div><div className="document-modal-actions"><button type="button" className="modal-secondary" onClick={()=>setNewDocOpen(false)}>Cancel</button><button type="submit" className="modal-primary">Create document</button></div></form></div>}{resizeOpen&&<div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setResizeOpen(false)}}><form className="document-modal" role="dialog" aria-modal="true" aria-labelledby="resize-image-title" onSubmit={event=>{event.preventDefault();commitResize()}}><div className="document-modal-header"><h2 id="resize-image-title">Resize image</h2><button type="button" className="quiet-icon" aria-label="Close resize dialog" onClick={()=>setResizeOpen(false)}><X size={14}/></button></div><p>Resample every pixel layer and mask independently.</p><div className="document-modal-fields"><label>Width<input type="number" min="1" max="30000" value={resizeW} onChange={event=>{const w=event.target.value;setResizeW(w);if(resizeLock&&Number(w)>0)setResizeH(String(Math.max(1,Math.round(Number(w)*size.h/size.w))))}}/></label><label>Height<input type="number" min="1" max="30000" value={resizeH} onChange={event=>{const h=event.target.value;setResizeH(h);if(resizeLock&&Number(h)>0)setResizeW(String(Math.max(1,Math.round(Number(h)*size.w/size.h))))}}/></label></div><label className="resize-lock"><input type="checkbox" checked={resizeLock} onChange={event=>setResizeLock(event.target.checked)}/>Maintain aspect ratio</label><label className="resize-sampling">Resampling<select value={resizeSampling} onChange={event=>setResizeSampling(event.target.value as typeof resizeSampling)}><option value="high">High quality (smooth)</option><option value="medium">Medium quality (smooth)</option><option value="nearest">Nearest neighbour</option></select></label><div className="document-modal-actions"><button type="button" className="modal-secondary" onClick={()=>setResizeOpen(false)}>Cancel</button><button type="submit" className="modal-primary">Resize</button></div></form></div>}{pendingCloseDocumentId&&<div className="modal-backdrop"><section className="document-modal" role="dialog" aria-modal="true" aria-labelledby="close-document-title"><div className="document-modal-header"><h2 id="close-document-title">Unsaved project changes</h2></div><p>Save changes to {documentsRef.current.find(doc=>doc.id===pendingCloseDocumentId)?.name||'this document'} before closing?</p><div className="document-modal-actions"><button type="button" className="modal-secondary" onClick={cancelCloseDocument}>Cancel</button><button type="button" className="modal-secondary" onClick={discardCloseDocument}>Don't Save</button><button type="button" className="modal-primary" onClick={()=>void saveAndCloseDocument()}>Save</button></div></section></div>}{appClosePrompt&&<div className="modal-backdrop"><section className="document-modal" role="dialog" aria-modal="true" aria-labelledby="quit-title"><div className="document-modal-header"><h2 id="quit-title">Unsaved project changes</h2></div><p>Save changes to all modified documents before closing PixelForge Studio?</p><div className="document-modal-actions"><button type="button" className="modal-secondary" onClick={()=>void cancelAppClose()}>Cancel</button><button type="button" className="modal-secondary" onClick={()=>void discardAllAndClose()}>Don't Save</button><button type="button" className="modal-primary" onClick={()=>void saveAllBeforeAppClose()}>Save All</button></div></section></div>}<input id="file-input" type="file" accept="image/png,image/jpeg,image/webp,image/bmp,image/gif" hidden onChange={e=>e.target.files?.[0]&&void addImage(e.target.files[0],e.target.files[0].name)}/><input ref={projectInputRef} type="file" accept=".pforge,application/x-pforge-project" hidden onChange={e=>void handleProjectFile(e.target.files?.[0])}/>{textEditor&&<div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)finishTextEditor(false)}}><form className="document-modal vector-text-modal" role="dialog" aria-modal="true" aria-labelledby="text-layer-title" onSubmit={event=>{event.preventDefault();finishTextEditor(true)}} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();finishTextEditor(false)}}}><div className="document-modal-header"><h2 id="text-layer-title">{textEditBefore.current?.layers.some(layer=>layer.id===textEditor!.layerId)?'Edit text layer':'New text layer'}</h2><button type="button" className="quiet-icon" aria-label="Close text editor" onClick={()=>finishTextEditor(false)}><X size={14}/></button></div><p>Text remains editable as a vector layer. Changes preview on the canvas.</p><label className="text-content-label">Text<textarea autoFocus aria-label="Text content" rows={5} value={textEditor!.data.content} onChange={event=>updateTextEditor({content:event.target.value})}/></label><div className="document-modal-fields"><label>Font family<input aria-label="Font family" value={textEditor!.data.fontFamily} list="pixelforge-windows-fonts" onChange={event=>updateTextEditor({fontFamily:event.target.value})} onBlur={event=>{const family=event.target.value.trim();if(family&&!document.fonts.check('16px "'+family+'"')){announce('Font '+family+' unavailable; using Segoe UI');updateTextEditor({fontFamily:'Segoe UI'})}}}/><datalist id="pixelforge-windows-fonts"><option value="Segoe UI"/><option value="Arial"/><option value="Calibri"/><option value="Cambria"/><option value="Consolas"/><option value="Georgia"/><option value="Tahoma"/><option value="Times New Roman"/><option value="Verdana"/></datalist></label><label>Size<input aria-label="Font size" type="number" min="1" max="2000" value={textEditor!.data.fontSize} onChange={event=>updateTextEditor({fontSize:Math.max(1,+event.target.value)})}/></label><label>Weight<select aria-label="Font weight" value={textEditor!.data.fontWeight} onChange={event=>updateTextEditor({fontWeight:+event.target.value as TextLayerData['fontWeight']})}>{[[400,'Regular'],[500,'Medium'],[600,'Semibold'],[700,'Bold'],[800,'Extra bold'],[900,'Black']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>Alignment<select aria-label="Text alignment" value={textEditor!.data.alignment} onChange={event=>updateTextEditor({alignment:event.target.value as TextLayerData['alignment']})}><option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option></select></label><label>Colour<input aria-label="Text colour" type="color" value={textEditor!.data.color} onChange={event=>updateTextEditor({color:event.target.value})}/></label><label>Tracking<input aria-label="Character spacing" type="number" min="-20" max="100" step="0.5" value={textEditor!.data.letterSpacing} onChange={event=>updateTextEditor({letterSpacing:+event.target.value})}/></label><label>Line spacing<input aria-label="Line spacing" type="number" min="0.5" max="4" step="0.1" value={textEditor!.data.lineSpacing} onChange={event=>updateTextEditor({lineSpacing:+event.target.value})}/></label><label>Box width<input aria-label="Text box width" type="number" min="1" max="30000" value={textEditor!.data.boxWidth} onChange={event=>updateTextEditor({boxWidth:Math.max(1,+event.target.value)})}/></label><label>Box height<input aria-label="Text box height" type="number" min="1" max="30000" value={textEditor!.data.boxHeight} onChange={event=>updateTextEditor({boxHeight:Math.max(1,+event.target.value)})}/></label></div><div className="text-style-options"><label><input type="checkbox" checked={textEditor!.data.italic} onChange={event=>updateTextEditor({italic:event.target.checked})}/> Italic</label><label><input type="checkbox" checked={textEditor!.data.underline} onChange={event=>updateTextEditor({underline:event.target.checked})}/> Underline</label><label><input type="checkbox" checked={textEditor!.data.strikethrough} onChange={event=>updateTextEditor({strikethrough:event.target.checked})}/> Strikethrough</label></div><div className="document-modal-actions"><button type="button" className="modal-secondary" onClick={()=>finishTextEditor(false)}>Cancel</button><button type="submit" className="modal-primary">Apply text</button></div></form></div>}</div>
 

}

