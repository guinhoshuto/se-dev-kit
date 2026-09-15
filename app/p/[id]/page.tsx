import {StudioEditor} from '../../../components/studio-editor';
export default async function ProjectPage({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  return <StudioEditor projectId={id} />;
}
