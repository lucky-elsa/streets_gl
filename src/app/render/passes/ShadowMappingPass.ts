import Pass from "./Pass";
import {InternalResourceType} from "~/lib/render-graph";
import RenderPassResource from "../render-graph/resources/RenderPassResource";
import PassManager from "../PassManager";
import AbstractMaterial from "~/lib/renderer/abstract-renderer/AbstractMaterial";
import {UniformFloat1, UniformMatrix4} from "~/lib/renderer/abstract-renderer/Uniform";
import Mat4 from "~/lib/math/Mat4";
import TreeDepthMaterialContainer from "../materials/TreeDepthMaterialContainer";
import AircraftDepthMaterialContainer from "../materials/AircraftDepthMaterialContainer";
import BuildingDepthMaterialContainer from "../materials/BuildingDepthMaterialContainer";
import ProjectedMeshDepthMaterialContainer from "~/app/render/materials/ProjectedMeshDepthMaterialContainer";
import AbstractTexture2DArray from "~/lib/renderer/abstract-renderer/AbstractTexture2DArray";
import CSMCascadeCamera from "~/app/render/CSMCascadeCamera";
import InstanceDepthMaterialContainer from "~/app/render/materials/InstanceDepthMaterialContainer";

export default class ShadowMappingPass extends Pass<{
	ShadowMaps: {
		type: InternalResourceType.Output;
		resource: RenderPassResource;
	};
	TerrainRingHeight: {
		type: InternalResourceType.Input;
		resource: RenderPassResource;
	};
}> {
	private readonly buildingDepthMaterial: AbstractMaterial;
	private readonly huggingMeshMaterial: AbstractMaterial;
	private readonly treeMaterial: AbstractMaterial;
	private readonly instanceMaterial: AbstractMaterial;
	private readonly aircraftMaterial: AbstractMaterial;

	public constructor(manager: PassManager) {
		super('ShadowMappingPass', manager, {
			ShadowMaps: {type: InternalResourceType.Output, resource: manager.getSharedResource('ShadowMaps')},
			TerrainRingHeight: {
				type: InternalResourceType.Input,
				resource: manager.getSharedResource('TerrainRingHeight')
			}
		});

		this.buildingDepthMaterial = new BuildingDepthMaterialContainer(this.renderer).material;
		this.huggingMeshMaterial = new ProjectedMeshDepthMaterialContainer(this.renderer).material;
		this.treeMaterial = new TreeDepthMaterialContainer(this.renderer).material;
		this.instanceMaterial = new InstanceDepthMaterialContainer(this.renderer).material;
		this.aircraftMaterial = new AircraftDepthMaterialContainer(this.renderer).material;

		this.listenToSettings();
	}

	private listenToSettings(): void {
		this.manager.settings.onChange('shadows', ({statusValue}) => {
			const csm = this.manager.sceneSystem.objects.csm;

			if (statusValue === 'low') {
				csm.cascades = 1;
				csm.resolution = 2048;
				csm.far = 3000;
			} else if (statusValue === 'medium') {
				csm.cascades = 3;
				csm.resolution = 2048;
				csm.far = 4000;
			} else {
				csm.cascades = 3;
				csm.resolution = 4096;
				csm.far = 5000;
			}

			csm.updateCascades();
			this.updateShadowMapDescriptor();
		}, true);
	}

	private updateShadowMapDescriptor(): void {
		const csm = this.manager.sceneSystem.objects.csm;
		this.getResource('ShadowMaps').descriptor.setSize(csm.resolution, csm.resolution, csm.cascades);
	}

	private renderBuildings(shadowCamera: CSMCascadeCamera): void {
		const tiles = this.manager.sceneSystem.objects.tiles;

		this.renderer.useMaterial(this.buildingDepthMaterial);

		this.buildingDepthMaterial.getUniform('projectionMatrix', 'PerMaterial').value = new Float32Array(shadowCamera.projectionMatrix.values);
		this.buildingDepthMaterial.updateUniformBlock('PerMaterial');

		for (const tile of tiles) {
			if (!tile.extrudedMesh || !tile.extrudedMesh.inCameraFrustum(shadowCamera)) {
				continue;
			}

			const mvMatrix = Mat4.multiply(shadowCamera.matrixWorldInverse, tile.matrixWorld);

			this.buildingDepthMaterial.getUniform<UniformMatrix4>('modelViewMatrix', 'PerMesh').value = new Float32Array(mvMatrix.values);
			this.buildingDepthMaterial.updateUniformBlock('PerMesh');

			tile.extrudedMesh.draw();
		}
	}

	private renderHuggingMeshes(shadowCamera: CSMCascadeCamera): void {
		const tiles = this.manager.sceneSystem.objects.tiles;
		const terrain = this.manager.sceneSystem.objects.terrain;

		this.huggingMeshMaterial.getUniform('tRingHeight').value =
			<AbstractTexture2DArray>this.getPhysicalResource('TerrainRingHeight').colorAttachments[0].texture;

		this.renderer.useMaterial(this.huggingMeshMaterial);

		this.huggingMeshMaterial.getUniform<UniformMatrix4>('projectionMatrix', 'PerMaterial').value =
			new Float32Array(shadowCamera.projectionMatrix.values);
		this.huggingMeshMaterial.updateUniformBlock('PerMaterial');

		for (const tile of tiles) {
			if (!tile.huggingMesh || !tile.huggingMesh.inCameraFrustum(shadowCamera)) {
				continue;
			}
			const {ring0, levelId, ring0Offset, ring1Offset} = terrain.getTileParams(tile);

			const mvMatrix = Mat4.multiply(shadowCamera.matrixWorldInverse, tile.matrixWorld);

			this.huggingMeshMaterial.getUniform('modelViewMatrix', 'PerMesh').value = new Float32Array(mvMatrix.values);
			this.huggingMeshMaterial.getUniform<UniformFloat1>('terrainRingSize', 'PerMesh').value[0] = ring0.size;
			this.huggingMeshMaterial.getUniform('terrainRingOffset', 'PerMesh').value = new Float32Array([
				ring0Offset.x, ring0Offset.y, ring1Offset.x, ring1Offset.y
			]);
			this.huggingMeshMaterial.getUniform<UniformFloat1>('terrainLevelId', 'PerMesh').value[0] = levelId;
			this.huggingMeshMaterial.getUniform<UniformFloat1>('segmentCount', 'PerMesh').value[0] = ring0.segmentCount * 2;
			this.huggingMeshMaterial.updateUniformBlock('PerMesh');

			tile.huggingMesh.draw();
		}
	}

	private renderInstances(shadowCamera: CSMCascadeCamera): void {
		for (const [name, instancedObject] of this.manager.sceneSystem.objects.instancedObjects.entries()) {
			const mvMatrix = Mat4.multiply(shadowCamera.matrixWorldInverse, instancedObject.matrixWorld);
			const material = name === 'tree' ? this.treeMaterial : this.instanceMaterial;

			this.renderer.useMaterial(material);

			material.getUniform('projectionMatrix', 'MainBlock').value = new Float32Array(shadowCamera.projectionMatrix.values);
			material.getUniform('modelViewMatrix', 'MainBlock').value = new Float32Array(mvMatrix.values);
			material.updateUniformBlock('MainBlock');

			instancedObject.mesh.draw();
		}
	}

	private renderAircraft(shadowCamera: CSMCascadeCamera): void {
		const aircraftList = this.manager.sceneSystem.objects.instancedAircraft;

		for (let i = 0; i < aircraftList.length; i++) {
			const aircraft = aircraftList[i];

			if (aircraft.mesh && aircraft.mesh.instanceCount > 0) {
				const mvMatrix = Mat4.multiply(shadowCamera.matrixWorldInverse, aircraft.matrixWorld);

				this.renderer.useMaterial(this.aircraftMaterial);

				this.aircraftMaterial.getUniform('projectionMatrix', 'MainBlock').value = new Float32Array(shadowCamera.projectionMatrix.values);
				this.aircraftMaterial.getUniform('modelViewMatrix', 'MainBlock').value = new Float32Array(mvMatrix.values);
				this.aircraftMaterial.updateUniformBlock('MainBlock');

				aircraft.mesh.draw();
			}
		}
	}

	public render(): void {
		const csm = this.manager.sceneSystem.objects.csm;
		const pass = this.getPhysicalResource('ShadowMaps');

		for (let i = 0; i < csm.cascadeCameras.length; i++) {
			const camera = csm.cascadeCameras[i];

			pass.depthAttachment.slice = i;

			this.renderer.beginRenderPass(pass);

			if (i < 2) {
				this.renderInstances(camera);
				this.renderAircraft(camera);
			}

			this.renderBuildings(camera);
			this.renderHuggingMeshes(camera);
		}
	}

	public setSize(width: number, height: number): void {

	}
}