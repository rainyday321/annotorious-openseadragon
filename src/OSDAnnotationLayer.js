import EventEmitter from 'tiny-emitter';
import OpenSeadragon from 'openseadragon';
import { SVG_NAMESPACE } from '@recogito/annotorious/src/util/SVG';
import DrawingTools from '@recogito/annotorious/src/tools/ToolsRegistry';
import { drawShape, shapeArea } from '@recogito/annotorious/src/selectors';
import { format } from '@recogito/annotorious/src/util/Formatting';
import { isTouchDevice, enableTouch } from '@recogito/annotorious/src/util/Touch';
import { getSnippet } from './util/ImageSnippet';

export default class OSDAnnotationLayer extends EventEmitter {

  constructor(props) {
    super();

    this.viewer = props.viewer;

    this.readOnly = props.config.readOnly;
    this.headless = props.config.headless;
    this.formatter = props.config.formatter;

    this.svg = document.createElementNS(SVG_NAMESPACE, 'svg');

    if (isTouchDevice()) {
      this.svg.setAttribute('class', 'a9s-annotationlayer a9s-osd-annotationlayer touch');
      enableTouch(this.svg);
    } else {
      this.svg.setAttribute('class', 'a9s-annotationlayer a9s-osd-annotationlayer');
    }    

    this.g = document.createElementNS(SVG_NAMESPACE, 'g');
    this.svg.appendChild(this.g);
    
    this.viewer.canvas.appendChild(this.svg);

    this.viewer.addHandler('animation', () => this.resize());
    this.viewer.addHandler('rotate', () => this.resize());
    this.viewer.addHandler('resize', () => this.resize());
    this.viewer.addHandler('flip', () => this.resize());

    this.viewer.addHandler('open', () => { 
      // Store image properties to environment
      const { x, y } = this.viewer.world.getItemAt(0).source.dimensions;
      
      props.env.image = {
        src: this.viewer.world.getItemAt(0).source['@id'] || 
          new URL(this.viewer.world.getItemAt(0).source.url, document.baseURI).href,
        naturalWidth: x,
        naturalHeight: y
      };

      this.resize();
    });

    this.selectedShape = null;

    if (!this.readOnly) {
      this.tools = new DrawingTools(this.g, props.config, props.env);
      this._initDrawingMouseTracker();
    }
  }

  /** Initializes the OSD MouseTracker used for drawing **/
  _initDrawingMouseTracker = () => {

    // Shorthand
    const toSVG = osdEvt => {
      const { layerX, layerY } = osdEvt.originalEvent;
      return this.tools.current.toSVG(layerX, layerY );
    }

    this.mouseTracker = new OpenSeadragon.MouseTracker({
      element: this.svg,

      pressHandler:  evt => {
        if (!this.tools.current.isDrawing)
          this.tools.current.start(evt.originalEvent);
      },

      moveHandler: evt => {
        if (this.tools.current.isDrawing) {
          const { x , y } = toSVG(evt);
          this.tools.current.onMouseMove(x, y, evt.originalEvent);
        }
      },

      releaseHandler: evt => {
        if (this.tools.current.isDrawing) {
          const { x , y } = toSVG(evt);
          this.tools.current.onMouseUp(x, y, evt.originalEvent);
        }
      }
    }).setTracking(false);

    this.tools.on('complete', shape => { 
      this.mouseTracker.setTracking(false);
      this.selectShape(shape);
      this.emit('createSelection', shape.annotation);
    });

    // Keep tracker disabled until Shift is held
    document.addEventListener('keydown', evt => {
      if (evt.which === 16 && !this.selectedShape) // Shift
        this.mouseTracker.setTracking(true);
    });

    document.addEventListener('keyup', evt => {
      if (evt.which === 16 && !this.tools.current.isDrawing)
        this.mouseTracker.setTracking(false);
    });
  }

  addAnnotation = annotation => {
    const shape = drawShape(annotation);
    shape.setAttribute('class', 'a9s-annotation');
    format(shape, annotation, this.formatter);

    shape.setAttribute('data-id', annotation.id);
    shape.annotation = annotation;

    shape.addEventListener('mouseenter', evt => {
      if (!this.tools?.current.isDrawing)
        this.emit('mouseEnterAnnotation', annotation, evt);
    });

    shape.addEventListener('mouseleave', evt => {
      if (!this.tools?.current.isDrawing)
        this.emit('mouseLeaveAnnotation', annotation, evt);
    });

    shape.mouseTracker = new OpenSeadragon.MouseTracker({
      element: shape,
      clickHandler: () => this.selectShape(shape)
    }).setTracking(true);

    this.g.appendChild(shape);
  }

  addDrawingTool = plugin =>
    this.tools.registerTool(plugin);

  addOrUpdateAnnotation = (annotation, previous) => {
    if (this.selectedShape?.annotation === annotation || this.selectShape?.annotation == previous)
      this.deselect();
  
    if (previous)
      this.removeAnnotation(annotation);

    this.removeAnnotation(annotation);
    this.addAnnotation(annotation);

    // Make sure rendering order is large-to-small
    this.redraw();
  }

  currentScale = () => {
    const containerWidth = this.viewer.viewport.getContainerSize().x;
    const zoom = this.viewer.viewport.getZoom(true);
    return zoom * containerWidth / this.viewer.world.getContentFactor();
  }

  deselect = skipRedraw => {
    if (this.selectedShape) {
      const { annotation } = this.selectedShape;

      if (annotation.isSelection)
        this.tools.current.stop();

      if (this.selectedShape.destroy) {
        // Modifiable shape: destroy and re-add the annotation
        this.selectedShape.mouseTracker.destroy();
        this.selectedShape.destroy();

        if (!annotation.isSelection)
          this.addAnnotation(annotation);

          if (!skipRedraw)
            this.redraw();
      }
      
      this.selectedShape = null;
    }
  }

  destroy = () => {
    this.selectedShape = null;
    this.mouseTracker.destroy();
    this.svg.parentNode.removeChild(this.svg);
  }

  findShape = annotationOrId => {
    const id = annotationOrId?.id ? annotationOrId.id : annotationOrId;
    return this.g.querySelector(`.a9s-annotation[data-id="${id}"]`);
  }

  fitBounds = (annotationOrId, immediately) => {
    const shape = this.findShape(annotationOrId);
    if (shape) {
      const { x, y, width, height } = shape.getBBox(); // SVG element bounds, image coordinates
      const rect = this.viewer.viewport.imageToViewportRectangle(x, y, width, height);
      this.viewer.viewport.fitBounds(rect, immediately);
    }    
  }

  getAnnotations = () => {
    const shapes = Array.from(this.g.querySelectorAll('.a9s-annotation'));
    return shapes.map(s => s.annotation);
  }

  getSelected = () => {
    if (this.selectedShape) {
      const { annotation } = this.selectedShape;
      const element = this.selectedShape.element || this.selectedShape;
      return { annotation, element };
    }
  }

  getSelectedImageSnippet = () => {
    if (this.selectedShape) {
      const shape = this.selectedShape.element ?? this.selectedShape;
      return getSnippet(this.viewer, shape);
    }
  }

  init = annotations => {
    const shapes = Array.from(this.g.querySelectorAll('.a9s-annotation'));
    shapes.forEach(s => this.g.removeChild(s));
    annotations.forEach(this.addAnnotation);
  }

  listDrawingTools = () =>
    this.tools.listTools();

  overrideId = (originalId, forcedId) => {
    // Update SVG shape data attribute
    const shape = this.findShape(originalId);
    shape.setAttribute('data-id', forcedId);

    // Update annotation
    const { annotation } = shape;

    const updated = annotation.clone({ id : forcedId });
    shape.annotation = updated;

    return updated;
  }

  panTo = (annotationOrId, immediately) => {
    const shape = this.findShape(annotationOrId);
    if (shape) {
      const { top, left, width, height } = shape.getBoundingClientRect();

      const x = left + width / 2 + window.scrollX;
      const y = top + height / 2 + window.scrollY;
      const center = this.viewer.viewport.windowToViewportCoordinates(new OpenSeadragon.Point(x, y));

      this.viewer.viewport.panTo(center, immediately);
    }    
  }

  redraw = () => {
    const shapes = Array.from(this.g.querySelectorAll('.a9s-annotation'));

    const annotations = shapes.map(s => s.annotation);
    annotations.sort((a, b) => shapeArea(b) - shapeArea(a));

    // Clear the SVG element
    shapes.forEach(s => this.g.removeChild(s));

    // Redraw
    annotations.forEach(this.addAnnotation);
  }
  
  removeAnnotation = annotationOrId => {
    // Removal won't work if the annotation is currently selected - deselect!
    const id = annotationOrId.type ? annotationOrId.id : annotationOrId;

    if (this.selectedShape?.annotation.id === id)
      this.deselect();
      
    const toRemove = this.findShape(annotationOrId);

    if (toRemove) {
      if (this.selectedShape?.annotation === toRemove.annotation)
        this.deselect();

      toRemove.mouseTracker.destroy();
      toRemove.parentNode.removeChild(toRemove);
    }
  }

  resize() {
    const flipped = this.viewer.viewport.getFlip();

    const p = this.viewer.viewport.pixelFromPoint(new OpenSeadragon.Point(0, 0), true);
    if (flipped)
      p.x = this.viewer.viewport._containerInnerSize.x - p.x;

    const scaleY = this.currentScale();
    const scaleX = flipped ? - scaleY : scaleY;
    const rotation = this.viewer.viewport.getRotation();

    this.g.setAttribute('transform', `translate(${p.x}, ${p.y}) scale(${scaleX}, ${scaleY}) rotate(${rotation})`);

    if (this.selectedShape) {
      if (this.selectedShape.element) { // Editable shape
        this.selectedShape.scaleHandles(1 / scaleY);
        this.emit('moveSelection', this.selectedShape.element);
      } else {
        this.emit('moveSelection', this.selectedShape); 
      }       
    }
  }
  
  selectAnnotation = (annotationOrId, skipEvent) => {
    if (this.selectedShape)
      this.deselect();

    const selected = this.findShape(annotationOrId);

    // Select with 'skipEvent' flag
    if (selected) {
      this.selectShape(selected, skipEvent);

      const element = this.selectedShape.element ? 
        this.selectedShape.element : this.selectedShape;

      return { annotation: selected.annotation, element };
    } else {
      this.deselect();
    }
  }

  selectShape = (shape, skipEvent) => {
    // Don't re-select
    if (this.selectedShape?.annotation === shape?.annotation)
      return;

    // If another shape is currently selected, deselect first
    if (this.selectedShape && this.selectedShape.annotation !== shape.annotation)
      this.deselect(true);

    const { annotation } = shape;

    const readOnly = this.readOnly || annotation.readOnly;

    if (!(readOnly || this.headless)) {
      // Replace the shape with an editable version
      shape.parentNode.removeChild(shape);  

      const toolForAnnotation = this.tools.forAnnotation(annotation);
      this.selectedShape = toolForAnnotation.createEditableShape(annotation);
      this.selectedShape.scaleHandles(1 / this.currentScale());

      this.selectedShape.element.annotation = annotation;        

      // Disable normal OSD nav
      const editableShapeMouseTracker = new OpenSeadragon.MouseTracker({
        element: this.svg
      }).setTracking(true);

      // En-/disable OSD nav based on hover status
      this.selectedShape.element.addEventListener('mouseenter', evt =>
        editableShapeMouseTracker.setTracking(true));
  
      this.selectedShape.element.addEventListener('mouseleave', evt =>
        editableShapeMouseTracker.setTracking(false));
      
      this.selectedShape.mouseTracker = editableShapeMouseTracker;
  
      this.selectedShape.on('update', fragment =>
        this.emit('updateTarget', this.selectedShape.element, fragment));

      if (!skipEvent)
        this.emit('select', { annotation, element: this.selectedShape.element });
    } else {
      this.selectedShape = shape;
      this.emit('select', { annotation, element: shape, skipEvent });   
    }
  }

  setDrawingEnabled = enable =>
    this.mouseTracker.setTracking(enable);

  setDrawingTool = shape =>
    this.tools.setCurrent(shape);

  setVisible = visible => {
    if (visible)
      this.svg.style.display = null;
    else
      this.svg.style.display = 'none';
  }

}